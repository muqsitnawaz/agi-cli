import { describe, expect, it } from 'vitest';
import type { ActiveSession } from './active.js';
import { SessionWatchState, sessionWatchRowKey, watchLocalSessions } from './watch.js';

const row = (sessionId: string, status: ActiveSession['status'] = 'running'): ActiveSession => ({
  context: 'terminal', kind: 'codex', sessionId, status, cwd: '/repo', lastActivityMs: 10,
});

describe('session watch protocol', () => {
  it('emits a versioned reset followed by stable-key deltas with monotonic sequence numbers', () => {
    const state = new SessionWatchState('stream-1');
    const reset = state.reset('zion', [row('a'), row('b')]);
    expect(reset).toMatchObject({ version: 1, type: 'reset', streamId: 'stream-1', sequence: 1, scope: 'zion' });
    const events = state.update('zion', [row('a', 'idle'), row('c')]);
    expect(events.map((event) => [event.type, event.sequence])).toEqual([['upsert', 2], ['upsert', 3], ['remove', 4]]);
    expect(sessionWatchRowKey('zion', row('a'))).toBe(sessionWatchRowKey('zion', row('a')));
  });

  it('marks a scope unavailable without removing its retained rows', () => {
    const state = new SessionWatchState('stream-2');
    state.reset('box', [row('retained', 'crashed')]);
    expect(state.scope('box', 'unavailable', 'ssh closed')).toMatchObject({ type: 'scope', status: 'unavailable', sequence: 2 });
    expect(state.update('box', [row('retained', 'crashed')])).toEqual([]);
  });

  it('uses one live-state loader and never invokes a history listing', async () => {
    const controller = new AbortController();
    let calls = 0;
    const events: unknown[] = [];
    await watchLocalSessions({
      scope: 'local', signal: controller.signal, refreshMs: 5, heartbeatMs: 50,
      load: async () => {
        calls++;
        if (calls === 2) controller.abort();
        return { sessions: [row('a')], servedFromCache: calls === 1, capturedAt: Date.now() };
      },
      emit: (event) => events.push(event),
    });
    expect(calls).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: 'reset' }));
  });
});
