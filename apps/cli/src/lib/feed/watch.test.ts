import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FeedWatchState,
  reconcileScopeAttention,
  buildFeedSnapshot,
  acceptFeedPeerEnvelope,
  resolutionForItem,
  watchLocalFeed,
  type FeedWatchEnvelope,
  type AgentProjection,
} from './watch.js';
import { publishBlock, blockIdForSession, type OpenBlock, type AttentionResolution } from './feed.js';
import type { AttentionItem } from './attention.js';
import type { ActiveSession } from '../session/active.js';

function tmpFeedDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feedwatch-test-'));
}

/** Minimal ActiveSession — only the fields the reconciler reads matter. */
function session(partial: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', host: 'zion', ...partial } as ActiveSession;
}

function block(partial: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: blockIdForSession(partial.sessionId ?? 'sess'),
    sessionId: partial.sessionId ?? 'sess',
    mailboxId: partial.mailboxId ?? (partial.sessionId ?? 'sess'),
    host: 'zion',
    runtime: 'claude',
    ts: '2026-08-23T10:00:00.000Z',
    questions: [{ text: 'ask?' }],
    ...partial,
  };
}

const NO_RES = new Map<string, AttentionResolution>();

// -------------------------------------------------------------------------
// Cross-harness fixtures (checklist 7): every harness produces the right
// attention source + kind, and the ONE portable signal (a declared block)
// works even for a harness that fires no hook event.
// -------------------------------------------------------------------------
describe('reconcileScopeAttention — cross-harness parity', () => {
  it('Claude AskUserQuestion (question block) → hook/question with numbered choices', () => {
    const { items } = reconcileScopeAttention({
      sessions: [session({ sessionId: 's1', activity: 'waiting_input', awaitingReason: 'question' })],
      blocks: [block({ sessionId: 's1', kind: 'question', runtime: 'claude', questions: [{ text: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] })],
      resolutions: NO_RES,
      nowMs: 20_000,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'hook', kind: 'question' });
    expect(items[0].choices?.map((c) => [c.id, c.label])).toEqual([['0', 'A'], ['1', 'B']]);
  });

  it('Claude permission notification (notification block) → hook/permission', () => {
    const { items } = reconcileScopeAttention({
      sessions: [session({ sessionId: 's2', activity: 'waiting_input', awaitingReason: 'permission' })],
      blocks: [block({ sessionId: 's2', kind: 'notification', runtime: 'claude' })],
      resolutions: NO_RES,
      nowMs: 20_000,
    });
    expect(items[0]).toMatchObject({ source: 'hook', kind: 'permission' });
  });

  it('Codex permission prompt (notification block, codex runtime) → hook/permission', () => {
    const { items } = reconcileScopeAttention({
      sessions: [session({ sessionId: 's3', kind: 'codex', activity: 'waiting_input', awaitingReason: 'permission' })],
      blocks: [block({ sessionId: 's3', kind: 'notification', runtime: 'codex', host: 'zion' })],
      resolutions: NO_RES,
      nowMs: 20_000,
    });
    expect(items[0]).toMatchObject({ source: 'hook', kind: 'permission' });
  });

  it('plan review (no block, structural session signal) → lifecycle/plan_review', () => {
    const { items } = reconcileScopeAttention({
      sessions: [session({ sessionId: 's4', activity: 'waiting_input', awaitingReason: 'plan_review', question: { text: 'Approve?', reason: 'plan_review' }, lastActivityMs: 4000 })],
      blocks: [],
      resolutions: NO_RES,
      nowMs: 20_000,
    });
    expect(items[0]).toMatchObject({ source: 'lifecycle', kind: 'plan_review', key: 'zion/s4/t4000' });
  });

  it('prose fallback (no block, bare question, no options) → heuristic/question', () => {
    const { items } = reconcileScopeAttention({
      sessions: [session({ sessionId: 's5', activity: 'waiting_input', awaitingReason: 'question', question: { text: 'what next?', reason: 'question' }, lastActivityMs: 5000 })],
      blocks: [],
      resolutions: NO_RES,
      nowMs: 20_000,
    });
    expect(items[0]).toMatchObject({ source: 'heuristic', kind: 'question' });
  });

  it('a harness with NO hook event: a declared block is the only signal → declared/declared', () => {
    // grok fires neither Notification nor PermissionRequest; `feed post --blocked`
    // is the one portable signal. The session reports `working` (no lifecycle
    // handoff) yet the declared block still wins.
    const { items } = reconcileScopeAttention({
      sessions: [session({ sessionId: 's6', kind: 'grok', activity: 'working', lastActivityMs: 6000 })],
      blocks: [block({ sessionId: 's6', kind: 'declared', source: 'declared', runtime: 'grok', questions: [{ text: 'Publish?', header: 'Needs you' }] })],
      resolutions: NO_RES,
      nowMs: 20_000,
    });
    expect(items[0]).toMatchObject({ source: 'declared', kind: 'declared' });
  });

  it('a declared block persists as an attention item after its session goes away', () => {
    const { items } = reconcileScopeAttention({
      sessions: [], // the live session row is gone; the declared block must persist
      blocks: [block({ sessionId: 's7', kind: 'declared', source: 'declared', state: 'open', runtime: 'kimi', host: 'mac-mini', questions: [{ text: 'Still stuck' }] })],
      resolutions: NO_RES,
      nowMs: 20_000,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'declared', sessionId: 's7', host: 'mac-mini' });
    // A gone session has no addressable reply rail — the reconciler says so.
    expect(items[0].replyCapability).toBe('none');
  });

  it('a resolution tombstone suppresses a stale lifecycle candidate', () => {
    const res = new Map<string, AttentionResolution>([
      [blockIdForSession('s8'), { blockId: blockIdForSession('s8'), generation: 't5000', resolvedAt: '2026-08-23T10:00:05.000Z', sourceCursor: { lastActivityMs: 5000 }, reason: 'continued' }],
    ]);
    const { items } = reconcileScopeAttention({
      sessions: [session({ sessionId: 's8', activity: 'waiting_input', awaitingReason: 'question', question: { text: 'q', reason: 'question' }, lastActivityMs: 5000 })],
      blocks: [],
      resolutions: res,
      nowMs: 20_000,
    });
    expect(items).toHaveLength(0);
  });
});

describe('buildFeedSnapshot', () => {
  it('joins each attention item inline onto its agent row, keyed by session id', () => {
    const snap = buildFeedSnapshot({
      scope: 'zion',
      sessions: [
        session({ sessionId: 'a', activity: 'waiting_input', awaitingReason: 'question' }),
        session({ sessionId: 'b', activity: 'working' }),
      ],
      blocks: [block({ sessionId: 'a', kind: 'question', questions: [{ text: 'Q', options: [{ label: 'x' }] }] })],
      resolutions: NO_RES,
      nowMs: 20_000,
    });
    expect(snap.agents).toHaveLength(2);
    const a = snap.agents.find((x) => x.sessionId === 'a')!;
    const b = snap.agents.find((x) => x.sessionId === 'b')!;
    expect(a.attention?.kind).toBe('question');
    expect(typeof a.rowKey).toBe('string');
    expect(b.attention).toBeUndefined();
    expect(snap.attention).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------
// FeedWatchState: sequencing + convergent diff + scope retention.
// -------------------------------------------------------------------------
function agent(rowKey: string, sessionId: string, extra: Partial<AgentProjection> = {}): AgentProjection {
  return { rowKey, sessionId, sourceDevice: 'zion', resumable: false, unwatched: true, viewingIn: null, recovery: null, context: 'terminal', kind: 'claude', status: 'running', host: 'zion', ...extra } as AgentProjection;
}
function attn(key: string, sessionId: string): AttentionItem {
  return { key, sessionId, mailboxId: sessionId, host: 'zion', kind: 'question', source: 'hook', state: 'open', openedAt: '2026-08-23T10:00:00.000Z', replyCapability: 'terminal', fingerprint: 'fp' } as AttentionItem;
}

describe('FeedWatchState', () => {
  it('stamps v/streamId/monotonic-sequence/capturedAt/scope on every envelope', () => {
    const state = new FeedWatchState('stream-1');
    const reset = state.reset('zion', [agent('r1', 's1')], [attn('zion/s1/g', 's1')]);
    expect(reset).toMatchObject({ v: 1, type: 'reset', streamId: 'stream-1', sequence: 1, scope: 'zion' });
    expect(typeof reset.capturedAt).toBe('number');
    const hb = state.heartbeat('zion');
    expect(hb.sequence).toBe(2);
    expect(hb.streamId).toBe('stream-1');
  });

  it('update emits agent.upsert + attention.upsert for new rows, attention.remove for gone ones', () => {
    const state = new FeedWatchState();
    state.reset('zion', [agent('r1', 's1')], [attn('zion/s1/g1', 's1')]);
    const resFor = (item: AttentionItem): AttentionResolution => resolutionForItem(item, NO_RES, 30_000);
    const events = state.update(
      'zion',
      [agent('r1', 's1', { status: 'idle' }), agent('r2', 's2')],
      [attn('zion/s2/g2', 's2')],
      resFor,
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('agent.upsert'); // r1 status change + r2 new
    expect(types).toContain('attention.upsert'); // s2 new
    expect(types).toContain('attention.remove'); // s1 gone
    const removed = events.find((e) => e.type === 'attention.remove') as Extract<FeedWatchEnvelope, { type: 'attention.remove' }>;
    expect(removed.rowKey).toBe('zion/s1/g1');
    expect(removed.resolution.blockId).toBe(blockIdForSession('s1'));
  });

  it('an agent REMOVAL forces a single reset (there is no agent.remove type)', () => {
    const state = new FeedWatchState();
    state.reset('zion', [agent('r1', 's1'), agent('r2', 's2')], []);
    const events = state.update('zion', [agent('r1', 's1')], [], (i) => resolutionForItem(i, NO_RES, 1));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('reset');
  });

  it('scope retention: an unavailable scope does not drop retained agents', () => {
    const state = new FeedWatchState();
    state.reset('zion', [agent('r1', 's1')], []);
    const scopeEvt = state.scope('zion', 'unavailable', 'ssh exited 255');
    expect(scopeEvt).toMatchObject({ type: 'scope', status: 'unavailable', reason: 'ssh exited 255' });
    // The retained agent is unchanged, so re-projecting the SAME set emits nothing.
    const events = state.update('zion', [agent('r1', 's1')], [], (i) => resolutionForItem(i, NO_RES, 1));
    expect(events).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------
// Coordinator forwarding contract (checklist 5): peer envelopes forward
// VERBATIM (peer streamId + sequence preserved), malformed lines dropped.
// -------------------------------------------------------------------------
describe('acceptFeedPeerEnvelope', () => {
  it('accepts a valid feed envelope verbatim (peer streamId + sequence preserved)', () => {
    const peer = { v: 1, type: 'heartbeat', streamId: 'peer-xyz', sequence: 42, capturedAt: 1, scope: 'mac-mini' };
    const out = acceptFeedPeerEnvelope(peer);
    expect(out).toBe(peer); // same object, not re-sequenced
    expect(out?.streamId).toBe('peer-xyz');
    expect(out?.sequence).toBe(42);
  });

  it('drops partial / non-protocol / wrong-version lines', () => {
    expect(acceptFeedPeerEnvelope({ v: 2, type: 'reset', sequence: 1 })).toBeUndefined();
    expect(acceptFeedPeerEnvelope({ v: 1, type: 'reset' })).toBeUndefined(); // no sequence
    expect(acceptFeedPeerEnvelope({ sequence: 1, type: 'reset' })).toBeUndefined(); // no v
    expect(acceptFeedPeerEnvelope(null)).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
// Live local watcher composition: an initial reset from real fs state.
// -------------------------------------------------------------------------
describe('watchLocalFeed (live composition)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  it('emits an initial reset that includes an open declared block from the feed store', async () => {
    const feedRoot = tmpFeedDir(); dirs.push(feedRoot);
    const activityDir = tmpFeedDir(); dirs.push(activityDir);
    publishBlock(block({ sessionId: 'live-1', kind: 'declared', source: 'declared', state: 'open', runtime: 'claude', questions: [{ text: 'Ship it?' }] }), feedRoot);

    const controller = new AbortController();
    const events: FeedWatchEnvelope[] = [];
    const task = watchLocalFeed({
      scope: 'zion',
      signal: controller.signal,
      emit: (e) => events.push(e),
      feedRoot,
      activityDir,
      prSource: null, // offline: no gh
      getSessions: async () => [], // no live sessions — the declared block must still surface
    });
    // Let the seed + initial reset flush, then stop.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await task;

    const reset = events.find((e) => e.type === 'reset') as Extract<FeedWatchEnvelope, { type: 'reset' }> | undefined;
    expect(reset).toBeDefined();
    expect(reset!.attention.some((a) => a.sessionId === 'live-1' && a.source === 'declared')).toBe(true);
  });
});
