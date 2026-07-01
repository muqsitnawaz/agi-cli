import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';

// Redirect the cache dir to a temp tree so saveTask/updateTask write there.
let CACHE_ROOT: string;
vi.spyOn(state, 'getCacheDir').mockImplementation(() => CACHE_ROOT);

// Mock ssh so the checkRemoteExit/fetchRemoteLog/refreshRunningTasks tests don't open real SSH.
const mockSshExec = vi.hoisted(() => vi.fn());
vi.mock('../ssh-exec.js', () => ({
  assertValidSshTarget: vi.fn(),
  sshExec: mockSshExec,
  sshExecRaw: mockSshExec,
  sshStream: vi.fn().mockReturnValue(255),
  shellQuote: (s: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`),
  controlOpts: vi.fn().mockReturnValue([]),
  SSH_OPTS: [],
}));

import { exitMarker, splitProgressBytes, mirrorAliasesSource, checkRemoteExit, fetchRemoteLog, refreshRunningTasks } from './progress.js';
import { saveTask, loadTask, type HostTask } from './tasks.js';

beforeEach(() => {
  CACHE_ROOT = mkdtempSync(join(tmpdir(), 'agents-cli-progress-'));
  mkdirSync(join(CACHE_ROOT, 'hosts'), { recursive: true });
  mockSshExec.mockReset();
});

afterEach(() => {
  rmSync(CACHE_ROOT, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('exitMarker', () => {
  it('embeds the task id so it cannot collide with generic output', () => {
    expect(exitMarker('a1b2c3d4')).toBe('\n@@AGENTS_HOST_EXIT_a1b2c3d4@@\n');
  });
});

describe('splitProgressBytes', () => {
  const id = 'a1b2c3d4';
  const M = exitMarker(id);
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

  it('splits log bytes from the exit code in a single combined fetch', () => {
    const r = splitProgressBytes(buf(`hello world${M}0`), id)!;
    expect(r.logChunk.toString('utf8')).toBe('hello world');
    expect(r.exit.toString('utf8')).toBe('0');
    expect(r.consumed).toBe(11); // 'hello world'
  });

  it('returns an empty exit while the job is still running', () => {
    const r = splitProgressBytes(buf(`some streamed output${M}`), id)!;
    expect(r.logChunk.toString('utf8')).toBe('some streamed output');
    expect(r.exit.toString('utf8')).toBe('');
  });

  it('reports an empty log chunk when there is no new output', () => {
    const r = splitProgressBytes(buf(`${M}`), id)!;
    expect(r.logChunk.length).toBe(0);
    expect(r.consumed).toBe(0);
    expect(r.exit.toString('utf8')).toBe('');
  });

  it('returns null when the marker is absent (transient fetch miss)', () => {
    expect(splitProgressBytes(buf('partial ssh output'), id)).toBeNull();
    expect(splitProgressBytes(buf(''), id)).toBeNull();
  });

  it('splits on the LAST marker so a token echoed in the log cannot spoof the boundary', () => {
    const echoed = `agent printed ${M} in its output`;
    const r = splitProgressBytes(buf(`${echoed}${M}137`), id)!;
    expect(r.exit.toString('utf8')).toBe('137');
    expect(r.logChunk.toString('utf8')).toBe(echoed);
  });

  it('is scoped per task id — another run’s marker is not treated as ours', () => {
    const other = exitMarker('ffffffff');
    expect(splitProgressBytes(buf(`log body${other}0`), id)).toBeNull();
  });

  // The load-bearing cases: byte-exact counting across a multibyte character.
  it('counts exact wire bytes when a multibyte char precedes the marker', () => {
    // 'héllo' is 6 UTF-8 bytes (é = 2); a string split would report 5 chars.
    const r = splitProgressBytes(buf(`héllo${M}0`), id)!;
    expect(r.consumed).toBe(6);
    expect(r.logChunk.length).toBe(6);
    expect(r.logChunk.toString('utf8')).toBe('héllo');
  });

  it('counts a multibyte char truncated at the buffer end by its raw bytes', () => {
    // 'café' = 5 bytes; drop the last byte so 'é' is split mid-character. The
    // next poll must resume exactly 4 bytes on — not skip/re-read — so consumed
    // MUST be 4, which a re-encoded U+FFFD (3 bytes) string count would get wrong.
    const half = buf('café').subarray(0, 4);
    const combined = Buffer.concat([half, Buffer.from(M, 'utf8')]);
    const r = splitProgressBytes(combined, id)!;
    expect(r.consumed).toBe(4);
    expect(r.logChunk.length).toBe(4);
  });
});

describe('mirrorAliasesSource', () => {
  it('flags aliasing when local and remote are the same file (localhost host)', () => {
    // Same dev:ino → the mirror IS the tailed file → skip the append.
    expect(mirrorAliasesSource('66306:1234567', '66306:1234567')).toBe(true);
  });

  it('does not flag distinct files (a genuine remote host)', () => {
    expect(mirrorAliasesSource('66306:1234567', '2049:9999999')).toBe(false);
  });

  it('does not flag when either identity is unknown', () => {
    // Missing local (mirror not created yet) or unstattable remote → keep mirroring.
    expect(mirrorAliasesSource(null, '2049:9999999')).toBe(false);
    expect(mirrorAliasesSource('66306:1234567', null)).toBe(false);
    expect(mirrorAliasesSource(null, null)).toBe(false);
  });
});

// --- #579 / RUSH-1360: checkRemoteExit, fetchRemoteLog, refreshRunningTasks ---

describe('checkRemoteExit', () => {
  it('returns null when the exit file is absent (run still in progress)', () => {
    mockSshExec.mockReturnValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    expect(checkRemoteExit('user@box', '$HOME/.agents/.cache/hosts/abc.exit')).toBeNull();
  });

  it('returns the parsed exit code when the exit file contains "0"', () => {
    mockSshExec.mockReturnValue({ code: 0, stdout: '0\n', stderr: '', timedOut: false });
    expect(checkRemoteExit('user@box', '$HOME/.agents/.cache/hosts/abc.exit')).toBe(0);
  });

  it('returns non-zero exit codes correctly', () => {
    mockSshExec.mockReturnValue({ code: 0, stdout: '137\n', stderr: '', timedOut: false });
    expect(checkRemoteExit('user@box', '$HOME/.agents/.cache/hosts/abc.exit')).toBe(137);
  });

  it('returns null for non-numeric exit content — a corrupt marker is not success', () => {
    mockSshExec.mockReturnValue({ code: 0, stdout: 'crash\n', stderr: '', timedOut: false });
    expect(checkRemoteExit('user@box', '$HOME/.agents/.cache/hosts/abc.exit')).toBeNull();
  });

  it('returns null when ssh itself fails (host unreachable)', () => {
    mockSshExec.mockReturnValue({ code: 255, stdout: '', stderr: 'Connection refused', timedOut: false });
    expect(checkRemoteExit('user@box', '$HOME/.agents/.cache/hosts/abc.exit')).toBeNull();
  });
});

describe('fetchRemoteLog', () => {
  it('returns log content when ssh succeeds', () => {
    mockSshExec.mockReturnValue({ code: 0, stdout: 'build started\nbuild done\n', stderr: '', timedOut: false });
    expect(fetchRemoteLog('user@box', '$HOME/.agents/.cache/hosts/abc.log')).toBe('build started\nbuild done\n');
  });

  it('returns null when ssh exits non-zero (host offline or cat error)', () => {
    mockSshExec.mockReturnValue({ code: 255, stdout: '', stderr: 'ssh: connect to host', timedOut: false });
    expect(fetchRemoteLog('user@box', '$HOME/.agents/.cache/hosts/abc.log')).toBeNull();
  });

  it('returns empty string for an empty log file (valid, not an error)', () => {
    mockSshExec.mockReturnValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    expect(fetchRemoteLog('user@box', '$HOME/.agents/.cache/hosts/abc.log')).toBe('');
  });
});

describe('refreshRunningTasks', () => {
  function makeTask(overrides: Partial<HostTask> = {}): HostTask {
    return {
      id: 'aabbccdd',
      host: 'box',
      target: 'user@box',
      agent: 'claude',
      prompt: 'do work',
      remoteLog: '$HOME/.agents/.cache/hosts/aabbccdd.log',
      remoteExit: '$HOME/.agents/.cache/hosts/aabbccdd.exit',
      status: 'running',
      createdAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('transitions a running task to completed when the exit file contains 0', () => {
    const task = makeTask({ id: 'rf000001' });
    saveTask(task);
    mockSshExec.mockReturnValue({ code: 0, stdout: '0\n', stderr: '', timedOut: false });

    refreshRunningTasks([task]);

    const updated = loadTask(task.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.exitCode).toBe(0);
    expect(updated?.finishedAt).toBeDefined();
  });

  it('transitions a running task to failed when the exit file contains a non-zero code', () => {
    const task = makeTask({ id: 'rf000002' });
    saveTask(task);
    mockSshExec.mockReturnValue({ code: 0, stdout: '1\n', stderr: '', timedOut: false });

    refreshRunningTasks([task]);

    const updated = loadTask(task.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.exitCode).toBe(1);
  });

  it('leaves a running task unchanged when the exit file is absent (still in progress)', () => {
    const task = makeTask({ id: 'rf000003' });
    saveTask(task);
    mockSshExec.mockReturnValue({ code: 0, stdout: '', stderr: '', timedOut: false });

    refreshRunningTasks([task]);

    const unchanged = loadTask(task.id);
    expect(unchanged?.status).toBe('running');
    expect(unchanged?.finishedAt).toBeUndefined();
  });

  it('skips already-terminal tasks — no SSH call for completed/failed', () => {
    const task = makeTask({ id: 'rf000004', status: 'completed' });
    saveTask(task);

    refreshRunningTasks([task]);

    expect(mockSshExec).not.toHaveBeenCalled();
  });
});
