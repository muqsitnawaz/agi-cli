import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import type { ActiveSession } from '../lib/session/active.js';
import type { SessionMeta } from '../lib/session/types.js';
import { buildSessionResumeCandidates, resumeCandidateState } from './sessions-resume-candidates.js';
import { registerSessionsResumeCommand } from './sessions-resume.js';

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: '97646f02-60f4-4d2d-bb63-00909441a446',
    shortId: '97646f02',
    agent: 'claude',
    version: '2.1.220',
    account: 'account@example.com',
    project: 'agents-cli',
    cwd: '/src/agents-cli',
    topic: 'Fix session resume with batch selection',
    timestamp: '2026-08-03T06:19:04.997Z',
    lastActivity: '2026-08-03T06:20:08.089Z',
    machine: 'zion',
    filePath: '/sessions/97646f02.jsonl',
    ...overrides,
  };
}

function live(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    pid: 74893,
    sessionId: '97646f02-60f4-4d2d-bb63-00909441a446',
    cwd: '/src/agents-cli',
    machine: 'zion',
    status: 'running',
    lastActivityMs: Date.parse('2026-08-03T06:20:08.089Z'),
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
    expect(resumeCandidateState(live({ status: 'crashed' }))).toBe('inactive');
  });
});

describe('buildSessionResumeCandidates', () => {
  it('returns the canonical state order, then newest activity, then stable id', () => {
    const rows = [
      session({ id: 'watched', shortId: 'watched' }),
      session({ id: 'detached', shortId: 'detached' }),
      session({ id: 'inactive', shortId: 'inactive' }),
      session({ id: 'background', shortId: 'background' }),
      session({ id: 'parked', shortId: 'parked' }),
    ];
    const active = new Map<string, ActiveSession>([
      ['watched', live({ sessionId: 'watched', viewingIn: { app: 'codium', tab: 1 } })],
      ['detached', live({ sessionId: 'detached' })],
      ['background', live({ sessionId: 'background', presence: 'background' })],
      ['parked', live({ sessionId: 'parked', presence: 'parked' })],
    ]);
    expect(buildSessionResumeCandidates(rows, active, 'zion').map((row) => row.id))
      .toEqual(['detached', 'background', 'parked', 'inactive', 'watched']);
  });

  it('orders equal-state rows by newest activity and then the full stable id', () => {
    const timestamp = '2026-08-03T06:20:08.089Z';
    const rows = [
      session({ id: 'deadbeef-ffff-4000-8000-000000000000', shortId: 'deadbeef', lastActivity: timestamp }),
      session({ id: 'newer', shortId: 'newer', lastActivity: '2026-08-04T06:20:08.089Z' }),
      session({ id: 'deadbeef-0000-4000-8000-000000000000', shortId: 'deadbeef', lastActivity: timestamp }),
    ];
    expect(buildSessionResumeCandidates(rows, new Map(), 'zion').map((row) => row.id)).toEqual([
      'newer',
      'deadbeef-0000-4000-8000-000000000000',
      'deadbeef-ffff-4000-8000-000000000000',
    ]);
  });

  it('emits source placement and one CLI-owned recovery invocation', () => {
    const candidate = buildSessionResumeCandidates(
      [session({ machine: 'Yosemite-S0.local' })],
      new Map(),
      'zion',
    )[0];
    expect(candidate.sourceHost).toBe('yosemite-s0');
    expect(candidate.host).toBe('yosemite-s0');
    expect(candidate.recovery).toEqual({
      command: 'agents',
      args: ['sessions', 'resume', session().id, '--host', 'yosemite-s0'],
      cwd: '/src/agents-cli',
    });
  });

  it('keeps live-only rows from the browser union and filters watched rows centrally', () => {
    const liveOnly = live({ sessionId: 'live-only', machine: 'zion' });
    const projected: SessionMeta = {
      ...session({ id: 'live-only', shortId: 'live-onl', filePath: '' }),
      timestamp: '2026-08-03T06:20:08.089Z',
    };
    const watched = session({ id: 'watched', shortId: 'watched' });
    const rows = buildSessionResumeCandidates(
      [projected, watched],
      new Map([
        ['live-only', liveOnly],
        ['watched', live({ sessionId: 'watched', viewingIn: { app: 'ghostty', tab: 2 } })],
      ]),
      'zion',
      true,
    );
    expect(rows.map((row) => row.id)).toEqual(['live-only']);
  });

  it('deduplicates ids and prefers the indexed label and latest live timestamp', () => {
    const row = session({ label: '<b>Named</b> session' });
    const result = buildSessionResumeCandidates(
      [row, row],
      new Map([[row.id, live({ lastActivityMs: 2_000_000_000_000 })]]),
      'zion',
    );
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe('Named session');
    expect(result[0].lastActivityMs).toBe(2_000_000_000_000);
  });

  it('excludes live processes that have no durable resume identity', () => {
    const projected = session({ id: 'p:74893', shortId: 'p:74893', filePath: '' });
    expect(buildSessionResumeCandidates(
      [projected],
      new Map([['p:74893', live({ sessionId: undefined })]]),
      'zion',
    )).toEqual([]);
  });
});

describe('sessions resume --candidates command', () => {
  it('rejects the real command path when the required --json flag is absent', async () => {
    const program = new Command();
    const sessions = program.command('sessions');
    registerSessionsResumeCommand(sessions);
    await expect(program.parseAsync([
      'node', 'agents', 'sessions', 'resume', '--candidates', '--local', '--limit', '1',
    ])).rejects.toThrow('--candidates requires --json.');
  });
});
