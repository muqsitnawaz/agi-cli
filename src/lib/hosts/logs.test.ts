import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';

// Redirect the cache dir to a temp tree (real fs, no service mocking) so we can
// stage real task sidecars + log files the way a dispatch would.
let CACHE_ROOT: string;
vi.spyOn(state, 'getCacheDir').mockImplementation(() => CACHE_ROOT);

// Mock progress.ts functions that open SSH connections so unit tests run without
// a live host. vi.hoisted() creates the refs before the module factory runs.
const { mockFollowHostTask, mockFetchRemoteLog } = vi.hoisted(() => ({
  mockFollowHostTask: vi.fn().mockResolvedValue(0),
  mockFetchRemoteLog: vi.fn().mockReturnValue(null as string | null),
}));

vi.mock('./progress.js', () => ({
  followHostTask: mockFollowHostTask,
  fetchRemoteLog: mockFetchRemoteLog,
}));

import { showHostTaskLog } from './logs.js';
import { saveTask, loadTask, localLogPath, type HostTask } from './tasks.js';

function makeTask(overrides: Partial<HostTask> = {}): HostTask {
  return {
    id: 'abc12345',
    host: 'box',
    target: 'user@box',
    agent: 'claude',
    prompt: 'do a thing',
    remoteLog: '$HOME/.agents/.cache/hosts/abc12345.log',
    remoteExit: '$HOME/.agents/.cache/hosts/abc12345.exit',
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

let out: string;
let errOut: string;
let writeSpy: ReturnType<typeof vi.spyOn>;
let errWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  CACHE_ROOT = mkdtempSync(join(tmpdir(), 'agents-cli-hostlogs-'));
  mkdirSync(join(CACHE_ROOT, 'hosts'), { recursive: true });
  out = '';
  errOut = '';
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  errWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errOut += String(chunk);
    return true;
  });
  mockFetchRemoteLog.mockReturnValue(null);
  mockFollowHostTask.mockResolvedValue(0);
});

afterEach(() => {
  writeSpy.mockRestore();
  errWriteSpy.mockRestore();
  rmSync(CACHE_ROOT, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('showHostTaskLog', () => {
  it('returns found:false for an unknown id (so callers can fall through to sessions)', async () => {
    const res = await showHostTaskLog('nope-not-a-task', false);
    expect(res.found).toBe(false);
    expect(res.exitCode).toBeUndefined();
    expect(out).toBe('');
  });

  it('prints the captured local log for a finished task and reports exit 0', async () => {
    const task = makeTask();
    saveTask(task);
    writeFileSync(localLogPath(task.id), 'PONG\n');

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(out).toBe('PONG\n');
    // No SSH call needed when local mirror exists.
    expect(mockFetchRemoteLog).not.toHaveBeenCalled();
  });

  it('does NOT follow (no SSH) a finished task even when follow is requested', async () => {
    // status !== 'running' → the follow branch is skipped.
    const task = makeTask({ id: 'done0001', status: 'completed' });
    saveTask(task);
    writeFileSync(localLogPath(task.id), 'final output\n');

    const res = await showHostTaskLog(task.id, true);

    expect(res.found).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(out).toBe('final output\n');
    expect(mockFollowHostTask).not.toHaveBeenCalled();
  });

  // --- Issue 1 fix: detached-run on-demand remote fetch ---

  it('fetches remote log on demand when no local mirror exists (detached run)', async () => {
    // Simulate a --no-follow dispatch: task record exists, no local log written.
    const task = makeTask({ id: 'detach01', status: 'completed' });
    saveTask(task);
    mockFetchRemoteLog.mockReturnValueOnce('remote output\n');

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    expect(out).toBe('remote output\n');
    expect(mockFetchRemoteLog).toHaveBeenCalledWith(task.target, task.remoteLog);
  });

  it('caches the remote fetch locally so subsequent calls are SSH-free', async () => {
    const task = makeTask({ id: 'detach02', status: 'completed' });
    saveTask(task);
    mockFetchRemoteLog.mockReturnValueOnce('cached content\n');

    await showHostTaskLog(task.id, false);

    // Second call: local mirror now exists, no second SSH call.
    out = '';
    mockFetchRemoteLog.mockClear();
    await showHostTaskLog(task.id, false);

    expect(out).toBe('cached content\n');
    expect(mockFetchRemoteLog).not.toHaveBeenCalled();
  });

  it('hints at -f when the remote fetch succeeds but the task is still running', async () => {
    const task = makeTask({ id: 'detach03', status: 'running' });
    saveTask(task);
    mockFetchRemoteLog.mockReturnValueOnce('partial output\n');

    await showHostTaskLog(task.id, false);

    expect(out).toBe('partial output\n');
    expect(errOut).toMatch(/Follow live/);
  });

  it('does NOT cache a running task — a second call re-fetches instead of serving a stale snapshot', async () => {
    const task = makeTask({ id: 'detach05', status: 'running' });
    saveTask(task);

    mockFetchRemoteLog.mockReturnValueOnce('partial 1\n');
    await showHostTaskLog(task.id, false); // running → fetch + print, must NOT cache

    out = '';
    mockFetchRemoteLog.mockClear();
    mockFetchRemoteLog.mockReturnValueOnce('partial 1\npartial 2\n');
    await showHostTaskLog(task.id, false); // must re-fetch (no local mirror), get fresh bytes

    expect(mockFetchRemoteLog).toHaveBeenCalledTimes(1); // re-fetched, not served from cache
    expect(out).toBe('partial 1\npartial 2\n'); // fresh, not the stale 'partial 1'
  });

  it('reports unavailable gracefully when the host is offline for a detached run', async () => {
    const task = makeTask({ id: 'detach04', status: 'completed' });
    saveTask(task);
    // mockFetchRemoteLog already defaults to null — host unreachable.

    const res = await showHostTaskLog(task.id, false);

    expect(res.found).toBe(true);
    // No stdout output (the "unavailable" notice goes to console.log).
    expect(out).toBe('');
  });

  // --- Issue 2 fix: status updated after following to completion ---

  it('updates task status to completed after following a running task to completion', async () => {
    const task = makeTask({ id: 'follow01', status: 'running' });
    saveTask(task);
    mockFollowHostTask.mockResolvedValueOnce(0);

    await showHostTaskLog(task.id, true);

    const updated = loadTask(task.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.exitCode).toBe(0);
    expect(updated?.finishedAt).toBeDefined();
  });

  it('updates task status to failed when the agent exits non-zero', async () => {
    const task = makeTask({ id: 'follow02', status: 'running' });
    saveTask(task);
    mockFollowHostTask.mockResolvedValueOnce(1);

    await showHostTaskLog(task.id, true);

    const updated = loadTask(task.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.exitCode).toBe(1);
  });

  it('records unknown status when followHostTask times out (exit -1)', async () => {
    const task = makeTask({ id: 'follow03', status: 'running' });
    saveTask(task);
    mockFollowHostTask.mockResolvedValueOnce(-1);

    const res = await showHostTaskLog(task.id, true);

    expect(res.exitCode).toBe(1); // -1 is surfaced as exit 1 to the caller
    const updated = loadTask(task.id);
    expect(updated?.status).toBe('unknown');
    expect(updated?.exitCode).toBeUndefined();
  });
});
