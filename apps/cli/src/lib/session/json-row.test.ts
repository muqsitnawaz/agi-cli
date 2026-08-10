import { describe, expect, it } from 'vitest';
import type { ActiveSession } from './active.js';
import type { SessionMeta } from './types.js';
import { enrichSessionJsonRows, sessionLifecycleState } from './json-row.js';

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: '97646f02-60f4-4d2d-bb63-00909441a446', shortId: '97646f02', agent: 'claude',
    timestamp: '2026-08-03T06:19:04.997Z', lastActivity: '2026-08-03T06:20:08.089Z',
    machine: 'zion', cwd: '/src/agents-cli', filePath: '/sessions/97646f02.jsonl', ...overrides,
  };
}

function live(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal', kind: 'claude', pid: 74893,
    sessionId: '97646f02-60f4-4d2d-bb63-00909441a446', machine: 'zion',
    status: 'running', lastActivityMs: Date.parse('2026-08-03T06:20:08.089Z'),
    tmuxTarget: 'ag-claude-97646f02:0.0',
    provenance: { transport: 'local', mux: { kind: 'tmux', pane: '%1' } }, ...overrides,
  } as ActiveSession;
}

describe('sessionLifecycleState', () => {
  it('classifies the canonical lifecycle states', () => {
    expect(sessionLifecycleState(undefined)).toBe('inactive');
    expect(sessionLifecycleState(live())).toBe('detached');
    expect(sessionLifecycleState(live({ viewingIn: { app: 'codium', tab: 3 } }))).toBe('watched');
    expect(sessionLifecycleState(live({ presence: 'background' }))).toBe('background');
    expect(sessionLifecycleState(live({ presence: 'parked' }))).toBe('parked');
    expect(sessionLifecycleState(live({ pidAlive: false }))).toBe('inactive');
  });
});

describe('enrichSessionJsonRows', () => {
  it('orders state, newest activity, then full id while preserving durable metadata', () => {
    const timestamp = '2026-08-03T06:20:08.089Z';
    const rows = [
      session({ id: 'watched', shortId: 'watched' }),
      session({ id: 'detached', shortId: 'detached' }),
      session({ id: 'deadbeef-ffff', shortId: 'deadbeef', lastActivity: timestamp, label: 'kept' }),
      session({ id: 'newer', shortId: 'newer', lastActivity: '2026-08-04T06:20:08.089Z' }),
      session({ id: 'deadbeef-0000', shortId: 'deadbeef', lastActivity: timestamp }),
    ];
    const active = new Map<string, ActiveSession>([
      ['watched', live({ sessionId: 'watched', viewingIn: { app: 'codium', tab: 1 } })],
      ['detached', live({ sessionId: 'detached' })],
    ]);
    const result = enrichSessionJsonRows(rows, active, 'zion');
    expect(result.map((row) => row.id)).toEqual([
      'detached', 'newer', 'deadbeef-0000', 'deadbeef-ffff', 'watched',
    ]);
    expect(result.find((row) => row.id === 'deadbeef-ffff')?.label).toBe('kept');
  });

  it('emits canonical resumability, source device, viewer, and recovery metadata', () => {
    const remote = session({ machine: 'Yosemite-S0.local' });
    const row = enrichSessionJsonRows([remote], new Map(), 'zion')[0];
    expect(row).toMatchObject({ state: 'inactive', resumable: true, unwatched: true, sourceDevice: 'yosemite-s0' });
    expect(row.recovery).toEqual({
      command: 'agents', args: ['sessions', 'resume', remote.id, '--host', 'yosemite-s0'], cwd: '/src/agents-cli',
    });
    const watched = enrichSessionJsonRows(
      [session()], new Map([[session().id, live({ viewingIn: { app: 'ghostty', tab: 2 } })]]), 'zion',
    )[0];
    expect(watched).toMatchObject({ state: 'watched', unwatched: false, viewingIn: 'ghostty tab 2' });
    expect(watched).toMatchObject({ context: 'terminal', kind: 'claude', status: 'running' });
  });
});
