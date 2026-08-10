import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActiveSession } from './active.js';
import { applyPeerSessionEvent, SessionWatchState, sessionWatchRowKey, watchLocalSessions } from './watch.js';

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

  it('binds peer rows and envelopes to the SSH device scope', () => {
    const remote = new SessionWatchState('remote-stream');
    const bound = new SessionWatchState('bound-stream');
    const rows = new Map<string, ActiveSession>();
    const [reset] = applyPeerSessionEvent(bound, 'remote-box', rows, remote.reset('local-machine', [row('unsafe; id')]));

    expect(reset).toMatchObject({ type: 'reset', streamId: 'bound-stream', scope: 'remote-box' });
    if (reset.type !== 'reset') throw new Error('expected reset');
    expect(reset.rows[0]).toMatchObject({
      sessionId: 'unsafe; id',
      sourceDevice: 'remote-box',
      recovery: { args: ['sessions', 'resume', 'unsafe; id', '--device', 'remote-box'] },
    });
    expect(reset.rows[0]?.machine).toBe('remote-box');
  });

  it('reads one reset then consumes multiple writer ticks with zero repeated gathers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    let snapshotReads = 0;
    const events: Array<{ type: string }> = [];
    const watching = watchLocalSessions({
      scope: 'local', signal: controller.signal, journalPath, journalPollMs: 5, heartbeatMs: 1_000,
      readCache: () => {
        snapshotReads++;
        return { version: 1, scope: 'local', capturedAt: 1, sessions: [row('a')] };
      },
      emit: (event) => {
        events.push(event);
        if (events.filter((candidate) => candidate.type === 'upsert').length === 2) controller.abort();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(journalPath, `${JSON.stringify({ version: 1, scope: 'local', capturedAt: 2, upserts: [row('a', 'idle')], removes: [] })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.appendFileSync(journalPath, `${JSON.stringify({ version: 1, scope: 'local', capturedAt: 3, upserts: [row('a', 'running'), row('b')], removes: [] })}\n`);
    await watching;
    expect(snapshotReads).toBe(1);
    expect(events.filter((event) => event.type === 'upsert')).toHaveLength(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('consumes a first publication written during the startup handoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-handoff-'));
    const journalPath = path.join(dir, 'active.jsonl');
    const controller = new AbortController();
    const statuses: string[] = [];
    const watching = watchLocalSessions({
      scope: 'local', signal: controller.signal, journalPath, journalPollMs: 5,
      readCache: () => {
        fs.appendFileSync(journalPath, `${JSON.stringify({
          version: 1, scope: 'local', capturedAt: 2, upserts: [], removes: [],
        })}\n`);
        return undefined;
      },
      emit: (event) => {
        if (event.type === 'scope') {
          statuses.push(event.status);
          if (event.status === 'available') controller.abort();
        }
      },
    });
    await watching;
    expect(statuses).toEqual(['unavailable', 'available']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not present a stale startup snapshot as available live state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watch-stale-'));
    const controller = new AbortController();
    const events: Array<{ type: string; status?: string; rows?: unknown[] }> = [];
    await watchLocalSessions({
      scope: 'local', signal: controller.signal, journalPath: path.join(dir, 'active.jsonl'),
      readCache: () => ({ version: 1, scope: 'local', capturedAt: 1, sessions: [row('stale')] }),
      emit: (event) => {
        events.push(event);
        if (event.type === 'scope') controller.abort();
      },
    });

    expect(events[0]).toMatchObject({ type: 'reset', rows: [] });
    expect(events[1]).toMatchObject({ type: 'scope', status: 'unavailable' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
