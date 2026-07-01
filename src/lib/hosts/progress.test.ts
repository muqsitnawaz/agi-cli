import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';

// Redirect the cache dir to a temp tree so saveTask/updateTask write there.
let CACHE_ROOT: string;
vi.spyOn(state, 'getCacheDir').mockImplementation(() => CACHE_ROOT);

// Mock sshExec so tests don't open real SSH connections.
const mockSshExec = vi.hoisted(() => vi.fn());
vi.mock('../ssh-exec.js', () => ({
  assertValidSshTarget: vi.fn(),
  sshExec: mockSshExec,
  sshStream: vi.fn().mockReturnValue(255),
  shellQuote: (s: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`),
  controlOpts: vi.fn().mockReturnValue([]),
  SSH_OPTS: [],
}));

import { exitMarker, splitProgressOutput, checkRemoteExit, fetchRemoteLog, refreshRunningTasks } from './progress.js';
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

describe('splitProgressOutput', () => {
  const id = 'a1b2c3d4';
  const M = exitMarker(id);

  it('splits log bytes from the exit code in a single combined fetch', () => {
    const out = `hello world${M}0`;
    expect(splitProgressOutput(out, id)).toEqual({ logChunk: 'hello world', exit: '0' });
  });

  it('returns an empty exit while the job is still running', () => {
    const out = `some streamed output${M}`;
    expect(splitProgressOutput(out, id)).toEqual({ logChunk: 'some streamed output', exit: '' });
  });

  it('reports an empty log chunk when there is no new output', () => {
    const out = `${M}`;
    expect(splitProgressOutput(out, id)).toEqual({ logChunk: '', exit: '' });
  });

  it('returns null when the marker is absent (transient fetch miss)', () => {
    expect(splitProgressOutput('partial ssh output', id)).toBeNull();
    expect(splitProgressOutput('', id)).toBeNull();
  });

  it('splits on the LAST marker so a token echoed in the log cannot spoof the boundary', () => {
    // The agent's own output literally contained the sentinel; the real
    // trailing marker must still win, keeping the echoed copy inside the log.
    const echoed = `agent printed ${M} in its output`;
    const out = `${echoed}${M}137`;
    const r = splitProgressOutput(out, id);
    expect(r).not.toBeNull();
    expect(r!.exit).toBe('137');
    expect(r!.logChunk).toBe(echoed);
  });

  it("is scoped per task id — another run's marker is not treated as ours", () => {
    const other = exitMarker('ffffffff');
    const out = `log body${other}0`;
    expect(splitProgressOutput(out, id)).toBeNull();
  });

  it('the printf-emitted sentinel round-trips through the parser (no desync)', () => {
    // fetchProgress builds the remote printf format by escaping exitMarker's
    // newlines; when the shell interprets those escapes it must reproduce the
    // exact marker the parser splits on. Simulate that here.
    const printfArg = exitMarker(id).replace(/\n/g, '\\n');
    const emitted = printfArg.replace(/\\n/g, '\n'); // what `printf` writes out
    expect(emitted).toBe(exitMarker(id));
    const r = splitProgressOutput(`body${emitted}0`, id);
    expect(r).toEqual({ logChunk: 'body', exit: '0' });
  });
});

// --- Issue 1 & 2 fixes: checkRemoteExit, fetchRemoteLog, refreshRunningTasks ---

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

  it('returns 0 for non-numeric exit file content (defensive fallback)', () => {
    mockSshExec.mockReturnValue({ code: 0, stdout: 'crash\n', stderr: '', timedOut: false });
    expect(checkRemoteExit('user@box', '$HOME/.agents/.cache/hosts/abc.exit')).toBe(0);
  });

  it('returns null when ssh itself fails (host unreachable)', () => {
    mockSshExec.mockReturnValue({ code: 255, stdout: '', stderr: 'Connection refused', timedOut: false });
    // SSH failure produces empty stdout → no exit file → null
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
