/**
 * Feed watch — the single reconciled operator projection AGI EXT consumes
 * (`agents feed watch --json`). It COMPOSES the existing local session watcher
 * ({@link watchLocalSessions}) with the feed/activity store and the pure
 * {@link reconcileAttention} merge, and reuses the existing fleet coordinator
 * ({@link watchFleetGeneric}) for the cross-device fan-out. It adds NO second
 * lifecycle detector and NO second scheduler: session lifecycle still comes from
 * the session watcher's journal, attention is a pure reconciliation of that plus
 * the feed block ledger, and the peer spawn/reconnect/scope machine is the same
 * one `agents sessions watch` uses.
 *
 * The stream is versioned NDJSON. Every envelope carries `v`, `streamId`,
 * `sequence`, `capturedAt`, and `scope`; consumers order by `streamId +
 * sequence` (forwarded peer envelopes keep the peer's own stream identity, never
 * re-sequenced). This shape is the contract AGI EXT's `SessionCliFactPayload`
 * (`apps/ext/src/monitor/protocol.ts`) already parses.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { machineId } from '../machine-id.js';
import { getActiveSessions, type ActiveSession } from '../session/active.js';
import {
  watchLocalSessions,
  watchFleetGeneric,
  toSessionWatchRow,
  type SessionWatchRow,
  type SessionWatchEnvelope,
} from '../session/remote/watch.js';
import { getFeedDir, getActivityDir } from '../state.js';
import { readRecentActivity, type ActivityEvent } from './activity.js';
import {
  listBlocks,
  listResolutions,
  blockIdForSession,
  deriveBlockState,
  type OpenBlock,
  type AttentionResolution,
} from './feed.js';
import { reconcileAttention, type AttentionItem } from './attention.js';
import { PrStatusSource, toAttentionSignal, type PullRequestAttentionSignal } from './pr-status.js';

export const FEED_WATCH_VERSION = 1 as const;
export const FEED_WATCH_HEARTBEAT_MS = 15_000;

export type FeedWatchScopeStatus = 'available' | 'unavailable';

/**
 * One projected agent row: the canonical session row PLUS its reconciled
 * attention record (joined inline for the row view) and CLI-sourced PR status
 * (the board projection). AGI EXT joins the same projected agent by session or
 * terminal id and never re-derives Needs-You.
 */
export interface AgentProjection extends SessionWatchRow {
  /** The reconciled attention record for this agent, when one is open. */
  attention?: AttentionItem;
  /** CLI-sourced PR status for this agent's PR, when known. */
  pullRequest?: PullRequestAttentionSignal;
}

/**
 * The versioned NDJSON envelope. `scope` is the owning device; `capturedAt` is a
 * wall-clock stamp. Agent rows are upsert-only within one stream — a removed
 * agent forces a fresh `reset` (there is no `agent.remove`, matching the AGI EXT
 * `SessionCliFactPayload` contract), while attention has its own `attention.remove`
 * carrying the resolution tombstone that closed it.
 */
export type FeedWatchEnvelope =
  | { v: 1; type: 'reset'; streamId: string; sequence: number; capturedAt: number; scope: string; agents: AgentProjection[]; attention: AttentionItem[] }
  | { v: 1; type: 'agent.upsert'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string; agent: AgentProjection }
  | { v: 1; type: 'attention.upsert'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string; attention: AttentionItem }
  | { v: 1; type: 'attention.remove'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string; resolution: AttentionResolution }
  | { v: 1; type: 'activity.append'; streamId: string; sequence: number; capturedAt: number; scope: string; event: ActivityEvent }
  | { v: 1; type: 'scope'; streamId: string; sequence: number; capturedAt: number; scope: string; status: FeedWatchScopeStatus; reason?: string }
  | { v: 1; type: 'heartbeat'; streamId: string; sequence: number; capturedAt: number; scope: string };

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The generation segment of an attention key (`host/session/generation`). */
function generationFromKey(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

/** Stream-local sequencer + convergent agent/attention diff for one feed watch stream. */
export class FeedWatchState {
  readonly streamId: string;
  private sequence = 0;
  private agents = new Map<string, AgentProjection>();
  private attention = new Map<string, AttentionItem>();

  constructor(streamId: string = randomUUID()) {
    this.streamId = streamId;
  }

  private base<T extends FeedWatchEnvelope['type']>(type: T, scope: string): { v: 1; type: T; streamId: string; sequence: number; capturedAt: number; scope: string } {
    return { v: FEED_WATCH_VERSION, type, streamId: this.streamId, sequence: ++this.sequence, capturedAt: Date.now(), scope };
  }

  reset(scope: string, agents: AgentProjection[], attention: AttentionItem[]): FeedWatchEnvelope {
    this.agents = new Map(agents.map((a) => [a.rowKey, a]));
    this.attention = new Map(attention.map((a) => [a.key, a]));
    return { ...this.base('reset', scope), agents, attention };
  }

  /**
   * Diff the current agent + attention sets against the previous emit. Agent
   * REMOVAL forces a single `reset` (no `agent.remove` type exists), so a gone
   * session cannot linger; otherwise emits incremental `agent.upsert`,
   * `attention.upsert`, and `attention.remove` (with the resolution tombstone).
   */
  update(
    scope: string,
    agents: AgentProjection[],
    attention: AttentionItem[],
    resolutionFor: (item: AttentionItem) => AttentionResolution,
  ): FeedWatchEnvelope[] {
    const nextAgents = new Map(agents.map((a) => [a.rowKey, a]));
    const agentRemoved = [...this.agents.keys()].some((k) => !nextAgents.has(k));
    if (agentRemoved) {
      return [this.reset(scope, agents, attention)];
    }

    const events: FeedWatchEnvelope[] = [];
    for (const [rowKey, agent] of nextAgents) {
      if (!this.agents.has(rowKey) || !sameJson(this.agents.get(rowKey), agent)) {
        events.push({ ...this.base('agent.upsert', scope), rowKey, agent });
      }
    }
    this.agents = nextAgents;

    const nextAttention = new Map(attention.map((a) => [a.key, a]));
    for (const [rowKey, item] of nextAttention) {
      if (!this.attention.has(rowKey) || !sameJson(this.attention.get(rowKey), item)) {
        events.push({ ...this.base('attention.upsert', scope), rowKey, attention: item });
      }
    }
    for (const [rowKey, prev] of this.attention) {
      if (!nextAttention.has(rowKey)) {
        events.push({ ...this.base('attention.remove', scope), rowKey, resolution: resolutionFor(prev) });
      }
    }
    this.attention = nextAttention;
    return events;
  }

  activity(scope: string, event: ActivityEvent): FeedWatchEnvelope {
    return { ...this.base('activity.append', scope), event };
  }

  scope(scope: string, status: FeedWatchScopeStatus, reason?: string): FeedWatchEnvelope {
    // Retain rows while unavailable — a reconnecting scope replaces them with a
    // reset; transient fleet loss must not look like agent death (mirrors the
    // sessions-watch retention contract).
    return { ...this.base('scope', scope), status, ...(reason ? { reason } : {}) };
  }

  heartbeat(scope: string): FeedWatchEnvelope {
    return this.base('heartbeat', scope);
  }
}

/** Best-available resolution tombstone for an attention item that just left the projection. */
export function resolutionForItem(
  item: AttentionItem,
  resolutions: Map<string, AttentionResolution>,
  nowMs: number,
): AttentionResolution {
  const blockId = blockIdForSession(item.sessionId);
  const recorded = resolutions.get(blockId);
  if (recorded) return recorded;
  // No tombstone on disk — synthesize one from the item's own generation so the
  // consumer still gets a stable removal reason.
  return {
    blockId,
    generation: generationFromKey(item.key),
    resolvedAt: new Date(nowMs).toISOString(),
    ...(item.sourceCursor ? { sourceCursor: item.sourceCursor } : {}),
    reason: 'session_advanced',
  };
}

export interface FeedSnapshot {
  agents: AgentProjection[];
  attention: AttentionItem[];
}

export interface ScopeAttention {
  items: AttentionItem[];
  /** sessionId -> its reconciled attention item, for joining onto agent rows. */
  bySession: Map<string, AttentionItem>;
}

/**
 * Reconcile a scope's live sessions, the feed block ledger, the resolution
 * tombstones, and CLI-supplied PR signals into the open attention set. PURE: no
 * filesystem, no clock, no transcript parsing — the same discipline as
 * {@link reconcileAttention}, which it calls once per candidate. An open block
 * whose session is no longer a live row still yields an attention item, so a
 * declared block persists in Needs-You after the turn ends.
 */
export function reconcileScopeAttention(input: {
  sessions: ActiveSession[];
  blocks: OpenBlock[];
  resolutions: Map<string, AttentionResolution>;
  prSignals?: Map<string, PullRequestAttentionSignal>;
  nowMs: number;
}): ScopeAttention {
  const blocksBySession = new Map<string, OpenBlock>();
  for (const block of input.blocks) blocksBySession.set(block.sessionId, block);

  const items: AttentionItem[] = [];
  const bySession = new Map<string, AttentionItem>();
  const liveSessionIds = new Set<string>();

  for (const session of input.sessions) {
    const sessionId = session.sessionId;
    if (sessionId) liveSessionIds.add(sessionId);
    const block = sessionId ? blocksBySession.get(sessionId) : undefined;
    const resolution = sessionId ? input.resolutions.get(blockIdForSession(sessionId)) : undefined;
    const pullRequest = sessionId ? input.prSignals?.get(sessionId) : undefined;
    const item = reconcileAttention({
      ...(block ? { block } : {}),
      session,
      ...(pullRequest ? { pullRequest } : {}),
      ...(resolution ? { resolution } : {}),
      nowMs: input.nowMs,
    });
    if (item) {
      items.push(item);
      if (sessionId) bySession.set(sessionId, item);
    }
  }

  // Open blocks whose session is no longer a live row — a declared block that
  // must persist in Needs-You after the turn ended. Reconcile against a minimal
  // synthesized session so the block-wins path still produces an item; a gone
  // session has no addressable reply rail, which the reconciler reports as such.
  for (const block of input.blocks) {
    if (liveSessionIds.has(block.sessionId)) continue;
    if (deriveBlockState(block) !== 'open') continue;
    const synthetic: ActiveSession = {
      context: 'headless',
      kind: block.runtime,
      status: 'idle',
      host: block.host,
      sessionId: block.sessionId,
      ...(block.project ? { project: block.project } : {}),
    } as ActiveSession;
    const resolution = input.resolutions.get(blockIdForSession(block.sessionId));
    const item = reconcileAttention({
      block,
      session: synthetic,
      ...(resolution ? { resolution } : {}),
      nowMs: input.nowMs,
    });
    if (item) items.push(item);
  }

  return { items, bySession };
}

/** Join one canonical session row with its attention + PR into an agent projection. */
export function projectAgentRow(
  row: SessionWatchRow,
  attention?: AttentionItem,
  pullRequest?: PullRequestAttentionSignal,
): AgentProjection {
  return {
    ...row,
    ...(attention ? { attention } : {}),
    ...(pullRequest ? { pullRequest } : {}),
  };
}

/** A canonical session row read back as a plain {@link ActiveSession} for reconciliation. */
export function sessionFromRow(row: SessionWatchRow): ActiveSession {
  // The watch-only fields (rowKey/sourceDevice/resumable/unwatched/recovery) and
  // the flattened `viewingIn` are not part of ActiveSession; drop them. The
  // reconciler never reads viewingIn.
  const { rowKey, sourceDevice, resumable, unwatched, viewingIn, recovery, ...session } = row;
  void rowKey; void sourceDevice; void resumable; void unwatched; void viewingIn; void recovery;
  return session as ActiveSession;
}

/**
 * Build the full operator projection (agent rows + attention) from a scope's
 * live sessions. PURE. Used by the answer resolver and the tests; the live
 * watcher builds agent rows from its own canonical rows via {@link projectAgentRow}.
 */
export function buildFeedSnapshot(input: {
  scope: string;
  sessions: ActiveSession[];
  blocks: OpenBlock[];
  resolutions: Map<string, AttentionResolution>;
  prSignals?: Map<string, PullRequestAttentionSignal>;
  nowMs: number;
}): FeedSnapshot {
  const { items, bySession } = reconcileScopeAttention(input);
  const agents = input.sessions.map((session) => {
    const sessionId = session.sessionId;
    const attention = sessionId ? bySession.get(sessionId) : undefined;
    const pullRequest = sessionId ? input.prSignals?.get(sessionId) : undefined;
    return projectAgentRow(toSessionWatchRow(input.scope, session), attention, pullRequest);
  });
  return { agents, attention: items };
}

/** Collect the resolution tombstones as a `blockId -> resolution` map. */
export function resolutionMap(feedRoot?: string): Map<string, AttentionResolution> {
  const map = new Map<string, AttentionResolution>();
  for (const res of listResolutions(feedRoot)) map.set(res.blockId, res);
  return map;
}

/** PR urls referenced by the live sessions or open blocks in this scope. */
function prUrlsFor(sessions: ActiveSession[], blocks: OpenBlock[]): Map<string, string> {
  // sessionId -> PR url
  const urls = new Map<string, string>();
  for (const s of sessions) {
    if (s.sessionId && s.pr?.url) urls.set(s.sessionId, s.pr.url);
  }
  for (const b of blocks) {
    if (!urls.has(b.sessionId) && b.pr) urls.set(b.sessionId, b.pr);
  }
  return urls;
}

export interface WatchLocalFeedOptions {
  scope: string;
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  feedRoot?: string;
  activityDir?: string;
  heartbeatMs?: number;
  pollMs?: number;
  /** Injectable PR source. Pass `null` to disable PR sourcing (e.g. offline tests). */
  prSource?: PrStatusSource | null;
  /** Injectable live-session reader (defaults to the canonical active-sessions cache). */
  getSessions?: () => Promise<ActiveSession[]>;
}

/**
 * Keep one local feed subscription alive: emit an initial reset, then re-project
 * on every session change (via the composed session watcher), feed-store change,
 * or activity append, plus a heartbeat. PR status refreshes on its own bounded
 * TTL out of band and triggers a re-project when a signal changes.
 */
export async function watchLocalFeed(options: WatchLocalFeedOptions): Promise<void> {
  const scope = options.scope;
  const feedRoot = options.feedRoot ?? getFeedDir();
  const activityDir = options.activityDir ?? getActivityDir();
  const heartbeatMs = options.heartbeatMs ?? FEED_WATCH_HEARTBEAT_MS;
  const pollMs = options.pollMs ?? 250;
  const getSessions = options.getSessions ?? getActiveSessions;
  const prSource = options.prSource === undefined ? new PrStatusSource() : options.prSource;

  const state = new FeedWatchState();
  const prSignals = new Map<string, PullRequestAttentionSignal>();
  const sessionRows = new Map<string, SessionWatchRow>();
  let started = false;

  const project = (): FeedSnapshot => {
    const rows = [...sessionRows.values()];
    const sessions = rows.map(sessionFromRow);
    const blocks = listBlocks(feedRoot);
    const { items, bySession } = reconcileScopeAttention({
      sessions,
      blocks,
      resolutions: resolutionMap(feedRoot),
      prSignals,
      nowMs: Date.now(),
    });
    const agents = rows.map((row) =>
      projectAgentRow(row, row.sessionId ? bySession.get(row.sessionId) : undefined, row.sessionId ? prSignals.get(row.sessionId) : undefined),
    );
    return { agents, attention: items };
  };

  const reproject = (): void => {
    if (options.signal.aborted) return;
    const snapshot = project();
    if (!started) {
      started = true;
      options.emit(state.reset(scope, snapshot.agents, snapshot.attention));
      return;
    }
    const resolutions = resolutionMap(feedRoot);
    const nowMs = Date.now();
    for (const event of state.update(scope, snapshot.agents, snapshot.attention, (item) => resolutionForItem(item, resolutions, nowMs))) {
      options.emit(event);
    }
  };

  // PR status refresh: bounded by the source's TTL, driven by projection cycles
  // rather than a standalone timer. When a signal changes, re-project once.
  let refreshingPr = false;
  const refreshPrSignals = async (): Promise<void> => {
    if (!prSource || refreshingPr || options.signal.aborted) return;
    refreshingPr = true;
    try {
      const urls = prUrlsFor([...sessionRows.values()].map(sessionFromRow), listBlocks(feedRoot));
      let changed = false;
      for (const [sessionId, url] of urls) {
        const row = await prSource.refresh(url);
        if (options.signal.aborted) return;
        const prev = prSignals.get(sessionId);
        const next = row ? toAttentionSignal(row) : undefined;
        if (next === undefined) {
          if (prSignals.delete(sessionId)) changed = true;
        } else if (!sameJson(prev, next)) {
          prSignals.set(sessionId, next);
          changed = true;
        }
      }
      // Drop signals for sessions that no longer reference a PR.
      for (const sessionId of [...prSignals.keys()]) {
        if (!urls.has(sessionId)) { prSignals.delete(sessionId); changed = true; }
      }
      if (changed && started && !options.signal.aborted) reproject();
    } finally {
      refreshingPr = false;
    }
  };

  // Compose the existing local session watcher — session lifecycle is NOT
  // re-detected here, it is consumed from the canonical session stream.
  const onSessionEvent = (event: SessionWatchEnvelope): void => {
    if (event.type === 'reset') {
      sessionRows.clear();
      for (const row of event.rows) sessionRows.set(row.rowKey, row);
    } else if (event.type === 'upsert') {
      sessionRows.set(event.rowKey, event.row);
    } else if (event.type === 'remove') {
      sessionRows.delete(event.rowKey);
    } else {
      return; // scope / heartbeat from the inner watcher are not feed state
    }
    reproject();
    void refreshPrSignals();
  };

  // Seed sessions once so the initial reset is not empty even before the inner
  // watcher's own reset fires (the inner reset re-seeds identically).
  try {
    for (const s of await getSessions()) {
      const row = toSessionWatchRow(scope, s);
      sessionRows.set(row.rowKey, row);
    }
  } catch { /* empty until the session watcher resets */ }
  reproject();
  void refreshPrSignals();
  if (options.signal.aborted) return;

  const sessionTask = watchLocalSessions({ scope, signal: options.signal, emit: onSessionEvent });

  await new Promise<void>((resolve) => {
    const feedListener = () => reproject();
    const resolutionsSub = path.join(feedRoot, 'resolutions');
    fs.mkdirSync(feedRoot, { recursive: true });
    fs.mkdirSync(resolutionsSub, { recursive: true });
    fs.watchFile(feedRoot, { interval: pollMs }, feedListener);
    fs.watchFile(resolutionsSub, { interval: pollMs }, feedListener);

    // Activity append: emit NEW events only (the reset covers current state).
    let activityCursor = Date.now();
    const activityListener = () => {
      if (options.signal.aborted) return;
      let events: ActivityEvent[];
      try { events = readRecentActivity({ root: activityDir, limit: 200 }); } catch { return; }
      const fresh = events
        .filter((e) => Date.parse(e.ts) > activityCursor)
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      for (const event of fresh) {
        options.emit(state.activity(scope, event));
        activityCursor = Math.max(activityCursor, Date.parse(event.ts));
      }
    };
    fs.mkdirSync(activityDir, { recursive: true });
    fs.watchFile(activityDir, { interval: pollMs }, activityListener);

    const heartbeatTimer = setInterval(() => options.emit(state.heartbeat(scope)), heartbeatMs);

    const stop = () => {
      fs.unwatchFile(feedRoot, feedListener);
      fs.unwatchFile(resolutionsSub, feedListener);
      fs.unwatchFile(activityDir, activityListener);
      clearInterval(heartbeatTimer);
      resolve();
    };
    options.signal.addEventListener('abort', stop, { once: true });
  });

  await sessionTask;
}

export interface WatchFleetFeedOptions {
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  reconnectMs?: number;
}

/**
 * Accept a parsed peer NDJSON line as a forwardable feed envelope, or `undefined`
 * to drop it. A valid envelope is forwarded VERBATIM (the peer's own `streamId +
 * sequence`), so ordering stays per-peer; a partial or non-protocol line is not
 * state. Exported so the forwarding contract is unit-testable.
 */
export function acceptFeedPeerEnvelope(parsed: unknown): FeedWatchEnvelope | undefined {
  const event = parsed as FeedWatchEnvelope;
  return (event && event.v === FEED_WATCH_VERSION && typeof event.sequence === 'number' && typeof event.type === 'string')
    ? event
    : undefined;
}

/**
 * Subscribe to every dialable compute device's feed watch with one persistent
 * SSH process each, reusing the shared fleet coordinator. Each peer runs
 * `agents feed watch --json --local`; its envelopes are forwarded verbatim
 * (peer's own `streamId + sequence`), and a disconnect emits a coordinator-side
 * `scope: unavailable` with last-rows retention until the peer reconnects.
 */
export async function watchFleetFeed(options: WatchFleetFeedOptions): Promise<void> {
  await watchFleetGeneric<FeedWatchEnvelope>({
    signal: options.signal,
    emit: options.emit,
    reconnectMs: options.reconnectMs,
    runLocal: (opts) => watchLocalFeed(opts),
    remoteArgs: ['feed', 'watch', '--json', '--local'],
    acceptPeerEnvelope: acceptFeedPeerEnvelope,
    makePeerScoper: (scope) => {
      const state = new FeedWatchState();
      return { scope: (status, reason) => state.scope(scope, status, reason) };
    },
  });
}
