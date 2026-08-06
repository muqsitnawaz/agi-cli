import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import {
  planKeychainReap,
  parseEtimeSecs,
  parsePsSnapshot,
  reapOrphanedKeychainProcesses,
  KEYCHAIN_ORPHAN_GRACE_SECS,
  KEYCHAIN_STUCK_CHILD_SECS,
  type KeychainProcSnapshot,
  type KeychainReapCandidate,
} from './reaper.js';
import { isAlive } from '../platform/index.js';

const HELPER = '/Users/x/Library/Application Support/agents-cli/Agents CLI.app/Contents/MacOS/Agents CLI';

function helperProc(over: Partial<KeychainProcSnapshot>): KeychainProcSnapshot {
  return { pid: 100, ppid: 1, elapsedSecs: 120, command: HELPER, startTime: 'st-100', ...over };
}

describe('parseEtimeSecs', () => {
  it('parses mm:ss', () => expect(parseEtimeSecs('05:32')).toBe(5 * 60 + 32));
  it('parses hh:mm:ss', () => expect(parseEtimeSecs('01:05:32')).toBe(3600 + 5 * 60 + 32));
  it('parses dd-hh:mm:ss', () => expect(parseEtimeSecs('2-03:04:05')).toBe(((2 * 24 + 3) * 60 + 4) * 60 + 5));
  it('tolerates surrounding whitespace', () => expect(parseEtimeSecs('  00:45 ')).toBe(45));
  it('returns null on garbage', () => {
    expect(parseEtimeSecs('')).toBeNull();
    expect(parseEtimeSecs('nope')).toBeNull();
    expect(parseEtimeSecs('12')).toBeNull();
  });
});

describe('parsePsSnapshot', () => {
  it('parses columns and keeps a space-containing command whole', () => {
    const out = [
      `  100     1 02:00 ${HELPER}`,
      ` 2000  1500 00:30 /usr/bin/node`,
      '', // blank line ignored
    ].join('\n');
    const rows = parsePsSnapshot(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 100, ppid: 1, elapsedSecs: 120, command: HELPER, startTime: null });
    expect(rows[1]).toMatchObject({ pid: 2000, ppid: 1500, elapsedSecs: 30, command: '/usr/bin/node' });
  });
  it('skips unparseable lines', () => {
    expect(parsePsSnapshot('garbage\n  x y z w')).toHaveLength(0);
  });
});

describe('planKeychainReap — class (a) orphaned helper', () => {
  it('reaps PPID==1 + path-match + older than grace', () => {
    const plan = planKeychainReap([helperProc({ pid: 100, ppid: 1, elapsedSecs: KEYCHAIN_ORPHAN_GRACE_SECS + 1 })], HELPER);
    expect(plan.kills).toHaveLength(1);
    expect(plan.kills[0]).toMatchObject({ pid: 100, role: 'orphaned-helper' });
  });
  it('does NOT reap within the grace window', () => {
    const plan = planKeychainReap([helperProc({ ppid: 1, elapsedSecs: KEYCHAIN_ORPHAN_GRACE_SECS })], HELPER);
    expect(plan.kills).toHaveLength(0);
  });
  it('does NOT reap a path mismatch even at PPID 1', () => {
    const plan = planKeychainReap([helperProc({ command: '/usr/bin/node', ppid: 1, elapsedSecs: 999 })], HELPER);
    expect(plan.kills).toHaveLength(0);
  });
  it('fails closed when start-time could not be captured', () => {
    const plan = planKeychainReap([helperProc({ ppid: 1, elapsedSecs: 999, startTime: null })], HELPER);
    expect(plan.kills).toHaveLength(0);
  });
  it('fails closed when the age is unknowable', () => {
    const plan = planKeychainReap([helperProc({ ppid: 1, elapsedSecs: null })], HELPER);
    expect(plan.kills).toHaveLength(0);
  });
});

describe('planKeychainReap — class (b) stuck helper child of a live parent', () => {
  const parent = { pid: 500, ppid: 1, elapsedSecs: 300, command: '/usr/bin/node', startTime: 'st-500' };
  const child = helperProc({ pid: 100, ppid: 500, elapsedSecs: KEYCHAIN_STUCK_CHILD_SECS + 5 });

  it('single sweep: records a candidate, kills nothing (debounce)', () => {
    const plan = planKeychainReap([parent, child], HELPER, []);
    expect(plan.kills).toHaveLength(0);
    expect(plan.nextCandidates).toHaveLength(1);
    expect(plan.nextCandidates[0]).toMatchObject({ childPid: 100, parentPid: 500, stage: 'sighted' });
  });

  it('second sweep: kills the child (frees the parent), carries a child-killed record', () => {
    const prev: KeychainReapCandidate[] = [
      { childPid: 100, childStartTime: 'st-100', parentPid: 500, parentStartTime: 'st-500', stage: 'sighted' },
    ];
    const plan = planKeychainReap([parent, child], HELPER, prev);
    expect(plan.kills).toHaveLength(1);
    expect(plan.kills[0]).toMatchObject({ pid: 100, role: 'stuck-helper-child' });
    expect(plan.nextCandidates).toEqual([
      expect.objectContaining({ parentPid: 500, parentStartTime: 'st-500', stage: 'child-killed' }),
    ]);
  });

  it('never reaps a live parent that owns NO helper child (a normal long session)', () => {
    const normalParent = { pid: 500, ppid: 1, elapsedSecs: 99999, command: '/usr/bin/node', startTime: 'st-500' };
    const plan = planKeychainReap([normalParent], HELPER, []);
    expect(plan.kills).toHaveLength(0);
    expect(plan.nextCandidates).toHaveLength(0);
  });

  it('does NOT treat a young helper child as stuck', () => {
    const young = helperProc({ pid: 100, ppid: 500, elapsedSecs: KEYCHAIN_STUCK_CHILD_SECS });
    const plan = planKeychainReap([parent, young], HELPER, []);
    expect(plan.kills).toHaveLength(0);
    expect(plan.nextCandidates).toHaveLength(0);
  });

  it('does NOT reap a child whose parent is absent from the snapshot', () => {
    const plan = planKeychainReap([child], HELPER, []); // no parent pid 500
    expect(plan.kills).toHaveLength(0);
    expect(plan.nextCandidates).toHaveLength(0);
  });

  it('escalates to the parent when it stays wedged a sweep after the child kill', () => {
    const prev: KeychainReapCandidate[] = [
      { childPid: 100, childStartTime: 'st-old', parentPid: 500, parentStartTime: 'st-500', stage: 'child-killed' },
    ];
    // The parent (still alive, same fingerprint) STILL owns an old helper child.
    const newChild = helperProc({ pid: 101, ppid: 500, elapsedSecs: KEYCHAIN_STUCK_CHILD_SECS + 5, startTime: 'st-101' });
    const plan = planKeychainReap([parent, newChild], HELPER, prev);
    expect(plan.kills.some((k) => k.pid === 500 && k.role === 'stuck-parent')).toBe(true);
  });

  it('does NOT escalate when the parent recovered (no stuck child remains)', () => {
    const prev: KeychainReapCandidate[] = [
      { childPid: 100, childStartTime: 'st-old', parentPid: 500, parentStartTime: 'st-500', stage: 'child-killed' },
    ];
    const plan = planKeychainReap([parent], HELPER, prev); // parent alive, no helper child now
    expect(plan.kills).toHaveLength(0);
  });

  it('does NOT escalate to a reused parent pid (start-time changed)', () => {
    const prev: KeychainReapCandidate[] = [
      { childPid: 100, childStartTime: 'st-old', parentPid: 500, parentStartTime: 'st-500', stage: 'child-killed' },
    ];
    const reusedParent = { pid: 500, ppid: 1, elapsedSecs: 300, command: '/usr/bin/node', startTime: 'st-DIFFERENT' };
    const newChild = helperProc({ pid: 101, ppid: 500, elapsedSecs: 999, startTime: 'st-101' });
    const plan = planKeychainReap([reusedParent, newChild], HELPER, prev);
    expect(plan.kills.some((k) => k.pid === 500)).toBe(false);
  });
});

describe('reapOrphanedKeychainProcesses (impure)', () => {
  it('is a no-op off darwin', () => {
    if (process.platform === 'darwin') return; // real behavior is exercised below on darwin
    const r = reapOrphanedKeychainProcesses();
    expect(r).toEqual({ reaped: 0, killed: [], nextCandidates: [] });
  });

  it.runIf(process.platform === 'darwin')('does not touch a normal (non-helper) process', () => {
    // A real, harmless sleeper whose command is NOT the helper path must survive.
    const child = spawn('sleep', ['5'], { stdio: 'ignore' });
    try {
      const r = reapOrphanedKeychainProcesses();
      expect(r.killed.some((k) => k.pid === child.pid)).toBe(false);
      expect(isAlive(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
