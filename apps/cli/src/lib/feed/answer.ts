/**
 * `agents feed answer <attention-key>` service — claim an open attention item and
 * route the reply to the waiting agent in ONE operation.
 *
 * This is Track B's answer path. It reuses the exact primitives `agents message`
 * composes — the O_EXCL atomic claim ({@link recordAnswer}), the rail selector
 * ({@link resolveAnswerRoute}), and the delivery primitives (mailbox
 * {@link enqueue}, {@link injectIntoTerminal}, headless {@link resumeArgv}) — but
 * returns a structured result instead of exiting the process, so a UI (AGI EXT)
 * can drive it and act on the outcome.
 *
 * The order is the contract: resolve the rail (no side effects), then ATOMICALLY
 * claim the first answer, then route, then advance the receipt. A losing
 * concurrent caller's claim fails on the answered marker, so it returns
 * `already_answered` and NEVER injects a second reply.
 */
import { spawn } from 'node:child_process';
import { machineId } from '../machine-id.js';
import { getActiveSessions, type ActiveSession } from '../session/active.js';
import { verifyOperatorIdentity } from '../operator.js';
import { mailboxDir, enqueue } from '../mailbox.js';
import { getAgentsInvocation } from '../daemon/daemon.js';
import { injectIntoTerminal } from '../terminal/index.js';
import { resolveAnswerRoute, resumeArgv, type AnswerRoute } from '../answer-router.js';
import {
  blockIdForSession,
  getAnswerRecord,
  isBlockAnswered,
  listBlocks,
  readBlock,
  recordAnswer,
  recordMessageReceipt,
  type MessageReceipt,
  type OpenBlock,
} from './feed.js';
import { type AttentionItem } from './attention.js';
import { buildFeedSnapshot, resolutionMap } from './watch.js';

/**
 * A resolved operator identity for a high-consequence answer. `verified` is true
 * only when the claimed id is in the local registry AND the process environment
 * proves it (`AGENTS_OPERATOR_ID`), exactly as {@link verifyOperatorIdentity}
 * requires — a caller cannot fabricate authority by passing a known id alone.
 */
export interface VerifiedOperator {
  operatorId?: string;
  verified: boolean;
}

/** Build a {@link VerifiedOperator} from a claimed `--as` id (proves it via the env). */
export function verifiedOperatorFromId(operatorId?: string): VerifiedOperator {
  return { operatorId, verified: verifyOperatorIdentity(operatorId) };
}

export interface ResolvedAttention {
  item: AttentionItem;
  block?: OpenBlock;
  session?: ActiveSession;
}

/** The session id embedded in an attention key (`host/session/generation`). */
export function sessionIdFromKey(attentionKey: string): string {
  const parts = attentionKey.split('/');
  return parts.length >= 3 ? parts.slice(1, -1).join('/') : attentionKey;
}

/** A `dropped` receipt for a caller that lost the claim — it routed nothing. */
function droppedReceipt(blockId: string, from: string): MessageReceipt {
  return { msgId: blockId, status: 'dropped', at: new Date().toISOString(), from };
}

/**
 * Resolve an attention key (`host/session/generation`) to the current attention
 * item plus its open block and live session. Builds the same reconciled snapshot
 * the watch stream emits, so a key answers only while it is a real, current open
 * item — a stale key resolves to `undefined`.
 */
export function resolveAttentionByKey(
  attentionKey: string,
  opts: { feedRoot?: string; sessions: ActiveSession[] },
): ResolvedAttention | undefined {
  const blocks = listBlocks(opts.feedRoot);
  const snapshot = buildFeedSnapshot({
    scope: machineId(),
    sessions: opts.sessions,
    blocks,
    resolutions: resolutionMap(opts.feedRoot),
    nowMs: Date.now(),
  });
  const item = snapshot.attention.find((a) => a.key === attentionKey);
  if (!item) return undefined;
  const block = readBlock(blockIdForSession(item.sessionId), opts.feedRoot);
  const session = opts.sessions.find((s) => s.sessionId === item.sessionId);
  return { item, ...(block ? { block } : {}), ...(session ? { session } : {}) };
}

/** The answer text for a pick: the option's delivery key when set, else its label. */
function answerTextForChoice(item: AttentionItem, choiceId: string): string {
  const choice = item.choices?.find((c) => c.id === choiceId);
  if (!choice) {
    throw new Error(`Attention item has no choice '${choiceId}'. Options: ${(item.choices ?? []).map((c) => c.id).join(', ') || 'none'}.`);
  }
  return choice.deliveryKey ?? choice.label;
}

export interface DeliverContext {
  mailboxId: string;
  blockId: string;
  answer: string;
  from?: string;
  feedRoot?: string;
}

/**
 * Route one answer over the chosen rail and return the delivery receipt. Throws
 * on a genuine delivery failure (a dead inject rail, a non-zero resume). Kept
 * separate + injectable so the claim-before-route ordering is unit-testable
 * without a live PTY.
 */
export async function deliverAnswerRoute(route: AnswerRoute, ctx: DeliverContext): Promise<MessageReceipt> {
  const at = new Date().toISOString();
  if (route.kind === 'mailbox') {
    const msgId = enqueue(mailboxDir(ctx.mailboxId), {
      to: ctx.mailboxId,
      text: ctx.answer,
      from: ctx.from,
      blockId: ctx.blockId,
    });
    const receipt: MessageReceipt = { msgId, status: 'queued', at, from: ctx.from };
    recordMessageReceipt(ctx.blockId, receipt, ctx.feedRoot);
    return receipt;
  }
  if (route.kind === 'tmux' || route.kind === 'iterm' || route.kind === 'pty') {
    if (!route.inject || route.payload == null) {
      throw new Error(`Internal error: inject route missing target/payload for ${ctx.mailboxId}.`);
    }
    const result = await injectIntoTerminal(route.inject, route.payload, { enter: true, combined: false });
    if (!result.ok) {
      throw new Error(`Failed to inject answer into ${route.inject.backend}: ${result.error ?? 'unknown error'}`);
    }
    const receipt: MessageReceipt = { msgId: `inject-${Date.parse(at)}`, status: 'queued', at, from: ctx.from };
    recordMessageReceipt(ctx.blockId, receipt, ctx.feedRoot);
    return receipt;
  }
  if (route.kind === 'resume') {
    const argv = resumeArgv(route);
    const inv = getAgentsInvocation(argv);
    // Non-interactive resume: a UI answer must not take over a TTY. Capture and
    // fail loud on a non-zero exit.
    const code: number = await new Promise((resolve) => {
      const child = spawn(inv.command, inv.args, { stdio: 'ignore', env: process.env });
      child.on('exit', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    if (code !== 0) {
      throw new Error(`Resume of ${ctx.mailboxId} exited with code ${code}. Tried: agents ${argv.join(' ')}`);
    }
    const receipt: MessageReceipt = { msgId: `resume-${Date.parse(at)}`, status: 'queued', at, from: ctx.from };
    recordMessageReceipt(ctx.blockId, receipt, ctx.feedRoot);
    return receipt;
  }
  // 'refuse' is handled before delivery; reaching here is a routing bug.
  throw new Error(`Cannot deliver answer: ${route.reason}`);
}

export type AnswerStatus = 'delivered' | 'already_answered';

export interface ClaimAndRouteResult {
  status: AnswerStatus;
  receipt: MessageReceipt;
}

export interface ClaimAndRouteInput {
  attentionKey: string;
  choiceId?: string;
  text?: string;
  operator: VerifiedOperator;
  feedRoot?: string;
  /** Injectable live sessions (defaults to the canonical active-session read). */
  sessions?: ActiveSession[];
  /** Injectable delivery for tests (defaults to {@link deliverAnswerRoute}). */
  deliver?: (route: AnswerRoute, ctx: DeliverContext) => Promise<MessageReceipt>;
}

/**
 * Claim the first answer for an attention item and route it to the waiting agent.
 *
 * - `delivered`: this caller won the atomic claim and the reply was routed.
 * - `already_answered`: a different surface already claimed it; this caller
 *   routes NOTHING (the losing-surface contract).
 *
 * Throws on an unauthorized high-consequence answer, an unknown/stale key, a
 * refused rail, or a genuine delivery failure — those are error conditions, not
 * the two-way delivered/already_answered result.
 */
export async function claimAndRouteAttentionAnswer(input: ClaimAndRouteInput): Promise<ClaimAndRouteResult> {
  const sessions = input.sessions ?? (await getActiveSessions());
  const resolved = resolveAttentionByKey(input.attentionKey, { feedRoot: input.feedRoot, sessions });
  if (!resolved) {
    // The item is no longer open. If a surface already answered its block, this
    // is a LATE loser — report already_answered (never an error), so the caller
    // knows to inject nothing. Only a genuinely unknown key is an error.
    const blockId = blockIdForSession(sessionIdFromKey(input.attentionKey));
    if (isBlockAnswered(blockId, input.feedRoot)) {
      const existing = getAnswerRecord(blockId, input.feedRoot);
      const who = existing
        ? existing.answeredFrom + (existing.answeredBy ? ` (${existing.answeredBy})` : '')
        : 'another surface';
      return { status: 'already_answered', receipt: droppedReceipt(blockId, who) };
    }
    throw new Error(`No open attention item matches '${input.attentionKey}'. It may have been answered or the session advanced.`);
  }
  const { item, block, session } = resolved;

  const answer =
    input.choiceId != null
      ? answerTextForChoice(item, input.choiceId)
      : (input.text ?? '').trim();
  if (!answer) {
    throw new Error('Provide an answer: --choice <choice-id> or --text <answer>.');
  }

  const blockId = blockIdForSession(item.sessionId);

  // Resolve the rail first (no side effects) so an un-routable ask refuses
  // BEFORE the claim, rather than claiming and then stranding the answer.
  const route = resolveAnswerRoute({
    mailboxId: item.mailboxId,
    answer,
    block: block ?? null,
    session: session ?? null,
  });
  if (route.kind === 'refuse') {
    throw new Error(route.reason);
  }

  // Atomic claim — the race gate. The FIRST caller to create the answered
  // marker wins; every other caller returns already_answered and delivers
  // nothing.
  const claim = recordAnswer(
    blockId,
    {
      answeredBy: input.operator.operatorId ?? 'feed',
      answeredFrom: 'feed',
      operatorId: input.operator.operatorId,
      verified: input.operator.verified,
    },
    input.feedRoot,
  );
  if (!claim.ok) {
    if ('unauthorized' in claim) {
      throw new Error(`Not authorized: ${claim.reason}`);
    }
    const who = claim.existing.answeredFrom + (claim.existing.answeredBy ? ` (${claim.existing.answeredBy})` : '');
    return { status: 'already_answered', receipt: droppedReceipt(blockId, who) };
  }

  const deliver = input.deliver ?? deliverAnswerRoute;
  const receipt = await deliver(route, {
    mailboxId: item.mailboxId,
    blockId,
    answer,
    from: input.operator.operatorId ?? 'feed',
    ...(input.feedRoot ? { feedRoot: input.feedRoot } : {}),
  });
  return { status: 'delivered', receipt };
}
