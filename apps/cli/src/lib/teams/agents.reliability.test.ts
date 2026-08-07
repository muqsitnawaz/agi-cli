/**
 * Teammate-state reliability — the silent-success failures that stranded a real
 * 5-track swarm (RUSH-2356 + RUSH-2366).
 *
 * These exercise the real AgentManager/AgentProcess lifecycle against a temp
 * meta.json dir (no mocking of the code under test). Only the ssh network
 * boundary is stubbed — the same seam the existing remote-poll test stubs — so
 * the `--device` liveness path runs for real without a live host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn as spawnProc } from 'child_process';

const { sshExecMock, sshExecRawMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn(),
  // pullRemoteLogDelta() runs before the liveness probe; return null-code so it
  // mirrors no bytes and the test stays focused on the sshExec liveness reading.
  sshExecRawMock: vi.fn(() => ({ code: null, stdout: Buffer.from(''), stderr: '' })),
}));

vi.mock('../ssh-exec.js', async () => {
  const actual = await vi.importActual<typeof import('../ssh-exec.js')>('../ssh-exec.js');
  return { ...actual, sshExec: sshExecMock, sshExecRaw: sshExecRawMock };
});

import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  isTerminalStatus,
  parseRemoteLivenessState,
} from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-reliability-'));
}

/** A local teammate persisted directly to disk at the given status. */
async function seed(
  base: string,
  id: string,
  status: AgentStatus,
  opts: { name?: string; after?: string[]; completedAt?: Date } = {},
): Promise<AgentProcess> {
  const agent = new AgentProcess(
    id, 'swarm', 'claude', 'do a thing',
    null, 'plan', null, status, new Date('2026-08-07T00:00:00.000Z'),
    opts.completedAt ?? (isTerminalStatus(status) ? new Date('2026-08-07T00:00:00.000Z') : null),
    base, null, null, null, null, null, null, null,
    opts.name ?? null, opts.after ?? [],
  );
  await agent.saveMeta();
  return agent;
}

function makeRemote(base: string, id: string): AgentProcess {
  const agent = new AgentProcess(
    id, 'swarm', 'claude', 'remote work',
    null, 'plan', null, AgentStatus.RUNNING, new Date('2026-08-07T00:00:00.000Z'),
    null, base,
  );
  agent.hostName = 'yosemite-s0';
  agent.hostTarget = 'yosemite-s0.tail1a85a1.ts.net';
  agent.remotePid = 4242;
  agent.remoteLog = '$HOME/.agents/.cache/hosts/aaaaaaaa.log';
  agent.remoteExit = '$HOME/.agents/.cache/hosts/aaaaaaaa.exit';
  return agent;
}

describe('RUSH-2356 — retention never reaps live teammates', () => {
  const dirs: string[] = [];
  afterEach(() => {
    sshExecMock.mockReset();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('listCompleted() returns only terminal statuses (never pending/running)', async () => {
    const base = tmpBase();
    dirs.push(base);
    await seed(base, 'done-1', AgentStatus.COMPLETED);
    await seed(base, 'failed-1', AgentStatus.FAILED);
    await seed(base, 'stopped-1', AgentStatus.STOPPED);
    await seed(base, 'pending-1', AgentStatus.PENDING, { name: 'p1', after: ['base'] });
    // A local running teammate with a live pid so it loads (and stays) RUNNING.
    const sleeper = spawnProc('sleep', ['60']);
    const running = await seed(base, 'running-1', AgentStatus.RUNNING);
    running.pid = sleeper.pid ?? null;
    await running.saveMeta();

    const mgr = new AgentManager(50, base);
    const completed = await mgr.listCompleted();
    const ids = completed.map((a) => a.agentId).sort();

    sleeper.kill('SIGKILL');
    expect(ids).toEqual(['done-1', 'failed-1', 'stopped-1']);
    expect(completed.every((a) => isTerminalStatus(a.status))).toBe(true);
  });

  it('cleanup past the 50-record cap never deletes a pending --after teammate', async () => {
    const base = tmpBase();
    dirs.push(base);

    // 51 terminal records — one over the default cap, so cleanup WILL fire.
    for (let i = 0; i < 51; i++) {
      await seed(base, `term-${String(i).padStart(3, '0')}`, AgentStatus.COMPLETED, {
        completedAt: new Date(Date.parse('2026-08-01T00:00:00.000Z') + i * 60_000),
      });
    }
    // Five staged (pending) --after teammates — the case that used to vanish.
    const pendingIds = ['stage-a', 'stage-b', 'stage-c', 'stage-d', 'stage-e'];
    for (const id of pendingIds) {
      await seed(base, id, AgentStatus.PENDING, { name: id, after: ['stage-anchor'] });
    }

    const mgr = new AgentManager(50, base);
    // Trigger the real cleanupOldAgents via a cloud-backed spawn (no CLI check,
    // no subprocess — the provider dispatch happened before spawn() in prod).
    await mgr.spawn(
      'swarm', 'claude', 'trigger', null, 'plan', 'medium', null, null,
      null, 'cleanup-trigger', [], null, null, null,
      'rush', 'sess-trigger',
    );

    // Every pending teammate MUST survive on disk and still be pending.
    for (const id of pendingIds) {
      const onDisk = await AgentProcess.loadFromDisk(id, base);
      expect(onDisk, `pending teammate ${id} was reaped by cleanup`).not.toBeNull();
      expect(onDisk!.status).toBe(AgentStatus.PENDING);
    }
    // Exactly one terminal record (the oldest) was reaped to honor the cap.
    const remainingTerminal = fs.readdirSync(base).filter((e) => e.startsWith('term-'));
    expect(remainingTerminal.length).toBe(50);
  });

  it('spawn() persists the record durably — loadFromDisk finds it', async () => {
    const base = tmpBase();
    dirs.push(base);
    const mgr = new AgentManager(50, base);
    const agent = await mgr.spawn(
      'swarm', 'claude', 'work', null, 'plan', 'medium', null, null,
      null, 'durable-1', [], null, null, null,
      'rush', 'sess-1',
    );
    const onDisk = await AgentProcess.loadFromDisk(agent.agentId, base);
    expect(onDisk).not.toBeNull();
    expect(onDisk!.name).toBe('durable-1');
  });

  it('validateAddPreconditions rejects a duplicate name and an unknown --after dep', async () => {
    const base = tmpBase();
    dirs.push(base);
    await seed(base, 'existing', AgentStatus.COMPLETED, { name: 'alice' });
    const mgr = new AgentManager(50, base);

    await expect(mgr.validateAddPreconditions('swarm', 'alice', [])).rejects.toThrow(/already has a teammate named 'alice'/);
    await expect(mgr.validateAddPreconditions('swarm', 'bob', ['ghost'])).rejects.toThrow(/no teammate named 'ghost'/);
    // A resolvable dep validates and returns the cleaned after-list (empties dropped).
    await expect(mgr.validateAddPreconditions('swarm', 'bob', ['alice', ''])).resolves.toEqual(['alice']);
  });
});

describe('RUSH-2366 — a dead teammate is reconciled, never RUNNING forever', () => {
  const dirs: string[] = [];
  afterEach(() => {
    sshExecMock.mockReset();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('parseRemoteLivenessState distinguishes ALIVE / EXITED / GONE', () => {
    expect(parseRemoteLivenessState('ALIVE', undefined)).toEqual({ alive: true, exit: null, exitFilePresent: false });
    expect(parseRemoteLivenessState('EXITED', '0')).toEqual({ alive: false, exit: '0', exitFilePresent: true });
    expect(parseRemoteLivenessState('EXITED', undefined)).toEqual({ alive: false, exit: '', exitFilePresent: true });
    expect(parseRemoteLivenessState('GONE', undefined)).toEqual({ alive: false, exit: null, exitFilePresent: false });
  });

  it('a local teammate whose pid is dead is marked FAILED on refresh', async () => {
    const base = tmpBase();
    dirs.push(base);
    const agent = await seed(base, 'dead-local', AgentStatus.RUNNING);
    // A pid that is not alive and never ours: refresh must reap it, not keep it
    // RUNNING. reapProcess finds no sentinel -> exit 1 -> FAILED.
    agent.pid = 2 ** 31 - 1;
    await agent.saveMeta();

    const mgr = new AgentManager(50, base);
    const [refreshed] = await mgr.listAll();
    expect(refreshed.status).toBe(AgentStatus.FAILED);
    expect(refreshed.completedAt).toBeInstanceOf(Date);
    expect(await mgr.listRunning()).toEqual([]);
  });

  it('a --device teammate whose process is GONE (no exit sentinel) is marked FAILED', async () => {
    const base = tmpBase();
    dirs.push(base);
    const agent = makeRemote(base, 'dead-remote');
    await agent.saveMeta();

    // Host says: process gone, no `.exit` at all -> "<id> GONE".
    sshExecMock.mockReturnValue({ code: 0, stdout: 'dead-remote GONE\n', stderr: '', timedOut: false });

    const mgr = new AgentManager(50, base);
    const [refreshed] = await mgr.listAll();
    expect(refreshed.status).toBe(AgentStatus.FAILED);
    expect(refreshed.completedAt).toBeInstanceOf(Date);
    // The reconciled terminal status is persisted.
    const onDisk = await AgentProcess.loadFromDisk('dead-remote', base);
    expect(onDisk!.status).toBe(AgentStatus.FAILED);
  });

  it('a still-ALIVE --device teammate stays RUNNING (no false reap)', async () => {
    const base = tmpBase();
    dirs.push(base);
    const agent = makeRemote(base, 'live-remote');
    await agent.saveMeta();
    sshExecMock.mockReturnValue({ code: 0, stdout: 'live-remote ALIVE\n', stderr: '', timedOut: false });

    const mgr = new AgentManager(50, base);
    const [refreshed] = await mgr.listAll();
    expect(refreshed.status).toBe(AgentStatus.RUNNING);
  });

  it('a transient ssh failure never reaps a --device teammate', async () => {
    const base = tmpBase();
    dirs.push(base);
    const agent = makeRemote(base, 'flaky-remote');
    await agent.saveMeta();
    sshExecMock.mockReturnValue({ code: null, stdout: '', stderr: 'ssh: connect timeout', timedOut: true });

    const mgr = new AgentManager(50, base);
    const [refreshed] = await mgr.listAll();
    expect(refreshed.status).toBe(AgentStatus.RUNNING);
  });

  it('a stale in-memory RUNNING never clobbers a newer on-disk terminal status', async () => {
    const base = tmpBase();
    dirs.push(base);
    // Manager A loads the teammate as RUNNING (remote, ALIVE at load).
    const agent = makeRemote(base, 'stopped-then-polled');
    await agent.saveMeta();
    sshExecMock.mockReturnValue({ code: 0, stdout: 'stopped-then-polled ALIVE\n', stderr: '', timedOut: false });
    const mgrA = new AgentManager(50, base);
    const [cached] = await mgrA.listAll();
    expect(cached.status).toBe(AgentStatus.RUNNING);

    // Another process (a separate `teams stop`) writes STOPPED to disk.
    const external = await AgentProcess.loadFromDisk('stopped-then-polled', base);
    external!.status = AgentStatus.STOPPED;
    external!.completedAt = new Date('2026-08-07T01:00:00.000Z');
    await external!.saveMeta();

    // Manager A polls its stale cached teammate. It must ADOPT the stopped status,
    // never re-persist RUNNING over it.
    await cached.updateStatusFromProcess();
    expect(cached.status).toBe(AgentStatus.STOPPED);
    const onDisk = await AgentProcess.loadFromDisk('stopped-then-polled', base);
    expect(onDisk!.status).toBe(AgentStatus.STOPPED);
  });

  it('rescanFromDisk refreshes a cached teammate that disk latched terminal', async () => {
    const base = tmpBase();
    dirs.push(base);
    const agent = makeRemote(base, 'rescan-me');
    await agent.saveMeta();
    sshExecMock.mockReturnValue({ code: 0, stdout: 'rescan-me ALIVE\n', stderr: '', timedOut: false });
    const mgr = new AgentManager(50, base);
    await mgr.listAll(); // caches it RUNNING

    // Externally latch it STOPPED on disk.
    const external = await AgentProcess.loadFromDisk('rescan-me', base);
    external!.status = AgentStatus.STOPPED;
    external!.completedAt = new Date('2026-08-07T01:00:00.000Z');
    await external!.saveMeta();

    await mgr.rescanFromDisk();
    const running = await mgr.listRunning();
    expect(running.find((a) => a.agentId === 'rescan-me')).toBeUndefined();
  });
});
