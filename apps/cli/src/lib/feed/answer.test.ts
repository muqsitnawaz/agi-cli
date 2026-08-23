import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  claimAndRouteAttentionAnswer,
  resolveAttentionByKey,
  type VerifiedOperator,
} from './answer.js';
import { reconcileScopeAttention } from './watch.js';
import {
  publishBlock,
  readBlock,
  blockIdForSession,
  isBlockAnswered,
  type OpenBlock,
  type AttentionResolution,
  type MessageReceipt,
} from './feed.js';
import type { ActiveSession } from '../session/active.js';
import type { AnswerRoute } from '../answer-router.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

function tmpFeedDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-answer-test-'));
  dirs.push(d);
  return d;
}

function session(partial: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', host: 'zion', ...partial } as ActiveSession;
}

function questionBlock(sessionId: string, partial: Partial<OpenBlock> = {}): OpenBlock {
  return {
    blockId: blockIdForSession(sessionId),
    sessionId,
    mailboxId: sessionId,
    host: 'zion',
    runtime: 'claude',
    ts: '2026-08-23T10:00:00.000Z',
    kind: 'question',
    questions: [{ text: 'Which?', options: [{ label: 'Augment' }, { label: 'Replace' }] }],
    ...partial,
  };
}

/** The live attention key for a session's open block (as the watch stream would emit). */
function keyFor(sessions: ActiveSession[], blocks: OpenBlock[]): string {
  const { items } = reconcileScopeAttention({ sessions, blocks, resolutions: new Map<string, AttentionResolution>(), nowMs: Date.now() });
  expect(items.length).toBeGreaterThan(0);
  return items[0].key;
}

const OPERATOR: VerifiedOperator = { verified: false };

describe('claimAndRouteAttentionAnswer', () => {
  it('resolves an attention key to its current open item', () => {
    const feedRoot = tmpFeedDir();
    const sess = session({ sessionId: 'r1', activity: 'working' });
    const blk = questionBlock('r1');
    publishBlock(blk, feedRoot);
    const key = keyFor([sess], [blk]);
    const resolved = resolveAttentionByKey(key, { feedRoot, sessions: [sess] });
    expect(resolved?.item.sessionId).toBe('r1');
    expect(resolved?.block?.blockId).toBe(blockIdForSession('r1'));
  });

  it('delivers via the real mailbox rail and records a queued receipt', async () => {
    const feedRoot = tmpFeedDir();
    const sess = session({ sessionId: 'r2', activity: 'working' }); // running, not parked → mailbox
    const blk = questionBlock('r2');
    publishBlock(blk, feedRoot);
    const key = keyFor([sess], [blk]);

    const result = await claimAndRouteAttentionAnswer({
      attentionKey: key,
      choiceId: '0',
      operator: OPERATOR,
      feedRoot,
      sessions: [sess],
    });
    expect(result.status).toBe('delivered');
    expect(result.receipt.status).toBe('queued');
    // The block is now claimed and carries the receipt.
    expect(isBlockAnswered(blockIdForSession('r2'), feedRoot)).toBe(true);
    const after = readBlock(blockIdForSession('r2'), feedRoot);
    expect(after?.receipts?.some((r: MessageReceipt) => r.msgId === result.receipt.msgId)).toBe(true);
  });

  it('atomic claim-before-route: the losing concurrent caller injects NOTHING', async () => {
    const feedRoot = tmpFeedDir();
    const sess = session({ sessionId: 'r3', activity: 'working' });
    const blk = questionBlock('r3');
    publishBlock(blk, feedRoot);
    const key = keyFor([sess], [blk]);

    let delivered = 0;
    const countingDeliver = async (_route: AnswerRoute): Promise<MessageReceipt> => {
      delivered += 1;
      return { msgId: `m${delivered}`, status: 'queued', at: new Date().toISOString() };
    };

    const first = await claimAndRouteAttentionAnswer({
      attentionKey: key, choiceId: '0', operator: OPERATOR, feedRoot, sessions: [sess], deliver: countingDeliver,
    });
    const second = await claimAndRouteAttentionAnswer({
      attentionKey: key, choiceId: '1', operator: OPERATOR, feedRoot, sessions: [sess], deliver: countingDeliver,
    });

    expect(first.status).toBe('delivered');
    expect(second.status).toBe('already_answered');
    expect(second.receipt.status).toBe('dropped');
    // The loser routed NOTHING — deliver ran exactly once.
    expect(delivered).toBe(1);
  });

  it('a choice id resolves to that option label as the routed answer', async () => {
    const feedRoot = tmpFeedDir();
    const sess = session({ sessionId: 'r4', activity: 'working' });
    const blk = questionBlock('r4');
    publishBlock(blk, feedRoot);
    const key = keyFor([sess], [blk]);

    let seen = '';
    await claimAndRouteAttentionAnswer({
      attentionKey: key, choiceId: '1', operator: OPERATOR, feedRoot, sessions: [sess],
      deliver: async (_r, ctx) => { seen = ctx.answer; return { msgId: 'x', status: 'queued', at: new Date().toISOString() }; },
    });
    expect(seen).toBe('Replace'); // option index 1
  });

  it('refuses an unauthorized high-consequence answer and routes nothing', async () => {
    const feedRoot = tmpFeedDir();
    const sess = session({ sessionId: 'r5', activity: 'working' });
    const blk = questionBlock('r5', { consequence: 'high' });
    publishBlock(blk, feedRoot);
    const key = keyFor([sess], [blk]);

    let delivered = 0;
    await expect(claimAndRouteAttentionAnswer({
      attentionKey: key, choiceId: '0',
      operator: { operatorId: 'nobody', verified: false },
      feedRoot, sessions: [sess],
      deliver: async () => { delivered += 1; return { msgId: 'x', status: 'queued', at: '' }; },
    })).rejects.toThrow(/Not authorized/);
    expect(delivered).toBe(0);
    expect(isBlockAnswered(blockIdForSession('r5'), feedRoot)).toBe(false);
  });

  it('throws on an unknown / stale attention key', async () => {
    const feedRoot = tmpFeedDir();
    await expect(claimAndRouteAttentionAnswer({
      attentionKey: 'zion/ghost/t1', text: 'hi', operator: OPERATOR, feedRoot, sessions: [],
    })).rejects.toThrow(/No open attention item/);
  });
});
