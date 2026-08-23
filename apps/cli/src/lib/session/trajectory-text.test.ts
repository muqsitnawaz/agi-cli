import { describe, it, expect } from 'vitest';
import { buildTrajectory } from './trajectory.js';
import { renderTrajectoryText } from './trajectory-text.js';
import type { SessionEvent, SessionMeta } from './types.js';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-0001',
    shortId: 'sess0001',
    agent: 'claude',
    timestamp: '2026-08-01T00:00:00Z',
    filePath: '/tmp/sess.jsonl',
    model: 'opus-4.8',
    ...overrides,
  };
}

const events: SessionEvent[] = [
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Read', callId: 'r1', args: { file_path: 'exec.ts' } },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Read', callId: 'r1', outcome: 'ok' },
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'b1', command: 'bun test exec.test.ts' },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:08:05Z', tool: 'Bash', callId: 'b1', outcome: 'error', exitCode: 1, output: 'exit 1 · 2 failing' },
  { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:08:05Z', tool: 'Edit', callId: 'e1', args: { file_path: 'exec.ts' } },
  { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:08:06Z', tool: 'Edit', callId: 'e1', outcome: 'ok' },
];

describe('renderTrajectoryText', () => {
  it('is ANSI-free and starts with a one-line header', () => {
    const text = renderTrajectoryText(buildTrajectory(events, meta()));
    expect(text.includes(String.fromCharCode(27))).toBe(false); // no ANSI escape sequences
    expect(text.split('\n')[0]).toContain('sess0001 claude·opus-4.8');
    expect(text).toContain('3 tools');
    expect(text).toContain('1✗');
  });

  it('lists steps with the effective PROGRAM (not the raw tool), duration, and exit code', () => {
    const text = renderTrajectoryText(buildTrajectory(events, meta()));
    // "bun" is the effective program of `bun test exec.test.ts` — never the naive "Bash".
    expect(text).toMatch(/bun\s+bun test exec\.test\.ts\s+8m04s exit 1 ✗/);
    expect(text).toContain('exit 1 · 2 failing'); // error evidence line
  });

  it('errorsOnly collapses to the error step and its neighbours', () => {
    const text = renderTrajectoryText(buildTrajectory(events, meta()), { errorsOnly: true });
    // Read (step 1) is not a neighbour of the error (step 2) — wait, it IS: step 2 is the error, step 1 and 3 are neighbours.
    expect(text).toContain('Bash'); // the error
    expect(text).toContain('Edit'); // neighbour after
    // With only 3 of 3 tool steps kept here, assert the collapse mechanism on a longer run below.
  });

  it('errorsOnly drops far-from-error steps and inserts a collapse marker', () => {
    const many: SessionEvent[] = [];
    for (let i = 0; i < 10; i++) {
      const ts = `2026-08-01T00:00:0${i}Z`;
      many.push({ type: 'tool_use', agent: 'claude', timestamp: ts, tool: 'Read', callId: `r${i}`, args: { file_path: `f${i}.ts` } });
      many.push({ type: 'tool_result', agent: 'claude', timestamp: ts, tool: 'Read', callId: `r${i}`, outcome: i === 5 ? 'error' : 'ok' });
    }
    const text = renderTrajectoryText(buildTrajectory(many, meta()), { errorsOnly: true });
    expect(text).toContain('…'); // collapse marker for the omitted head
    expect(text).not.toContain('f0.ts'); // far-from-error step dropped
    expect(text).toContain('f5.ts'); // the error step kept
    expect(text).toContain('f6.ts'); // neighbour kept
  });

  it('is bounded: a huge session collapses the step list with a count', () => {
    const many: SessionEvent[] = [];
    for (let i = 0; i < 300; i++) {
      const ts = new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString();
      many.push({ type: 'tool_use', agent: 'claude', timestamp: ts, tool: 'Read', callId: `r${i}`, args: { file_path: `f${i}.ts` } });
      many.push({ type: 'tool_result', agent: 'claude', timestamp: ts, tool: 'Read', callId: `r${i}`, outcome: 'ok' });
    }
    const text = renderTrajectoryText(buildTrajectory(many, meta()), { maxSteps: 50 });
    expect(text.split('\n').length).toBeLessThan(70); // bounded, not 300 lines
    expect(text).toMatch(/… \d+ more steps/);
  });

  it('renders an idle gap as a divider between the steps it falls between, not a wall-clock axis', () => {
    const withGap: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:03:11Z', tool: 'Read', callId: 'r1', args: { file_path: 'a' } },
    ];
    const text = renderTrajectoryText(buildTrajectory(withGap, meta(), { idleThresholdMs: 120_000 }));
    expect(text).toMatch(/···\s+idle 3m10s\s+···/);
  });

  it('renders a gap that falls BEFORE the first step (afterOrdinal: 0), not just between steps', () => {
    // A regression test for the divider loop starting `prevMs` at `null` instead
    // of the session origin — that silently dropped a leading stall (the gap
    // record's `afterOrdinal` is 0, since no step precedes it).
    const leadingGap: SessionEvent[] = [
      { type: 'message', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', role: 'user', content: 'go' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:03:20Z', tool: 'Bash', callId: 'c1', command: 'ls' },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:03:21Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const traj = buildTrajectory(leadingGap, meta(), { idleThresholdMs: 120_000 });
    expect(traj.gaps).toEqual([{ startMs: 0, durationMs: 200_000, afterOrdinal: 0 }]);
    const text = renderTrajectoryText(traj);
    const lines = text.split('\n');
    const gapLine = lines.findIndex((l) => l.includes('idle'));
    const stepLine = lines.findIndex((l) => l.startsWith('01 '));
    expect(gapLine).toBeGreaterThanOrEqual(0);
    expect(gapLine).toBeLessThan(stepLine);
  });

  it('breaks the tool mix down by effective program, and reports an analysis summary line', () => {
    const text = renderTrajectoryText(buildTrajectory(events, meta()));
    expect(text).toContain('analysis: 1 error');
    expect(text).toMatch(/tool mix: .*\bbun 1\b/);
  });

  it('redacts a secret in a step label', () => {
    const secret = 'sk-supersecrettoken1234567890';
    const withSecret: SessionEvent[] = [
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-01T00:00:00Z', tool: 'Bash', callId: 'c1', command: `auth ${secret}` },
      { type: 'tool_result', agent: 'claude', timestamp: '2026-08-01T00:00:01Z', tool: 'Bash', callId: 'c1', outcome: 'ok' },
    ];
    const text = renderTrajectoryText(buildTrajectory(withSecret, meta(), { redact: true, knownSecrets: [secret] }));
    expect(text).not.toContain(secret);
  });
});
