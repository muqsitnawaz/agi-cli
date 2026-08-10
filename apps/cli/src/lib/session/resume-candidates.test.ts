import { describe, expect, it } from 'vitest';
import type { ActiveSession } from './active.js';
import type { SessionMeta } from './types.js';
import { buildSessionResumeCandidates, resumeCandidateState } from './resume-candidates.js';

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: '97646f02-60f4-4d2d-bb63-00909441a446',
    shortId: '97646f02', agent: 'claude', version: '2.1.220', account: 'account@example.com',
    project: 'agents-cli', cwd: '/src/agents-cli', topic: 'Fix session resume with batch selection',
    timestamp: '2026-08-03T06:19:04.997Z', lastActivity: '2026-08-03T06:20:08.089Z',
    machine: 'zion', filePath: '/sessions/97646f02.jsonl', ...overrides,
  };
}

function live(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal', kind: 'claude', pid: 74893,
    sessionId: '97646f02-60f4-4d2d-bb63-00909441a446', cwd: '/src/agents-cli',
    machine: 'zion', status: 'running', lastActivityMs: Date.parse('2026-08-03T06:20:08.089Z'),
    tmuxTarget: 'ag-claude-97646f02:0.0',
    provenance: { transport: 'local', mux: { kind: 'tmux', pane: '%1' } },
    ...overrides,
  } as ActiveSession;
}

describe('resumeCandidateState', () => {
  it('owns the complete live lifecycle classification', () => {
    expect(resumeCandidateState(undefined)).toBe('inactive');
    expect(resumeCandidateState(live())).toBe('detached');
    expect(resumeCandidateState(live({ viewingIn: { app: 'codium', tab: 3 } }))).toBe('watched');
    expect(resumeCandidateState(live({ presence: 'background' }))).toBe('background');
    expect(resumeCandidateState(live({ presence: 'parked' }))).toBe('parked');
    expect(resumeCandidateState(live({ pidAlive: false }))).toBe('inactive');
  });
});

describe('buildSessionResumeCandidates', () => {
  it('orders state, then newest activity, then the full stable id', () => {
    const timestamp = '2026-08-03T06:20:08.089Z';
    const rows = [
      session({ id: 'watched', shortId: 'watched' }),
      session({ id: 'detached', shortId: 'detached' }),
      session({ id: 'deadbeef-ffff-4000-8000-000000000000', shortId: 'deadbeef', lastActivity: timestamp }),
      session({ id: 'newer', shortId: 'newer', lastActivity: '2026-08-04T06:20:08.089Z' }),
      session({ id: 'deadbeef-0000-4000-8000-000000000000', shortId: 'deadbeef', lastActivity: timestamp }),
    ];
    const active = new Map<string, ActiveSession>([
      ['watched', live({ sessionId: 'watched', viewingIn: { app: 'codium', tab: 1 } })],
      ['detached', live({ sessionId: 'detached' })],
    ]);
    expect(buildSessionResumeCandidates(rows, active, 'zion').map((row) => row.id)).toEqual([
      'detached', 'newer', 'deadbeef-0000-4000-8000-000000000000',
      'deadbeef-ffff-4000-8000-000000000000', 'watched',
    ]);
  });

  it('emits canonical unwatched state, source placement, and recovery invocation', () => {
    const remote = session({ machine: 'Yosemite-S0.local' });
    const candidate = buildSessionResumeCandidates([remote], new Map(), 'zion')[0];
    expect(candidate.unwatched).toBe(true);
    expect(candidate.sourceHost).toBe('yosemite-s0');
    expect(candidate.recovery).toEqual({
      command: 'agents',
      args: ['sessions', 'resume', remote.id, '--host', 'yosemite-s0'],
      cwd: '/src/agents-cli',
    });
    const watched = buildSessionResumeCandidates(
      [session()],
      new Map([[session().id, live({ viewingIn: { app: 'ghostty', tab: 2 } })]]),
      'zion',
    )[0];
    expect(watched.unwatched).toBe(false);
  });

  it('deduplicates stable ids and excludes live processes without a durable resume identity', () => {
    const row = session({ label: '<b>Named</b> session' });
    expect(buildSessionResumeCandidates([row, row], new Map(), 'zion')).toHaveLength(1);
    const projected = session({ id: 'p:74893', shortId: 'p:74893', filePath: '' });
    expect(buildSessionResumeCandidates(
      [projected], new Map([['p:74893', live({ sessionId: undefined })]]), 'zion',
    )).toEqual([]);
  });
});
