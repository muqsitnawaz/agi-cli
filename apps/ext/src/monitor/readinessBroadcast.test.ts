// End-to-end broadcast round-trip (no mocks).
//
// A real MonitorHost with detectors enabled, a real MonitorFollower over a real
// Unix socket, and a real shell pid. Proves the #68/#69 acceptance: the leader
// runs ONE probe/watch per pid/root and the follower receives the broadcast
// facts it would resolve back to its own terminals.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MonitorHost } from './host';
import { MonitorFollower } from './follower';
import {
  isReadinessFact,
  ReadinessFactPayload,
  TerminalTuple,
} from './protocol';
import { MonitorEvent } from './broadcastTypes';

const spawned: ChildProcess[] = [];
const tmpPaths: string[] = [];
let counter = 0;

function tempSocketPath(): string {
  const p = path.join(os.tmpdir(), `monitor-rb-${process.pid}-${counter++}.sock`);
  tmpPaths.push(p);
  return p;
}

function spawnShellWithChild(): number {
  const shell = spawn('bash', ['-c', '(node -e "setInterval(()=>{}, 1e9)") ; true'], {
    stdio: 'ignore',
  });
  spawned.push(shell);
  return shell.pid!;
}

function tuple(over: Partial<TerminalTuple>): TerminalTuple {
  return {
    windowId: 'win',
    terminalId: 'CC-1',
    pid: null,
    sessionId: null,
    workspacePath: null,
    agentType: null,
    ...over,
  };
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const p of tmpPaths.splice(0)) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

describe('readiness broadcast round-trip', () => {
  test('leader probes a reported pid once and the follower receives agentReady', async () => {
    const socketPath = tempSocketPath();
    const pid = spawnShellWithChild();
    const host = new MonitorHost({ socketPath, detectors: { sessionCli: false } });
    await host.start();

    const readinessFacts: ReadinessFactPayload[] = [];
    const follower = new MonitorFollower<string>({
      windowId: 'winA',
      socketPath,
      clientOptions: { minReconnectDelayMs: 25, maxReconnectDelayMs: 100 },
      // A real window would resolve pid -> its vscode.Terminal here.
      resolver: ({ pid: p }) => (p === pid ? 'termA' : undefined),
    });
    const sub = follower.onMonitorEvent((e: MonitorEvent) => {
      if (isReadinessFact(e)) readinessFacts.push(e.payload);
    });

    try {
      follower.start();
      await waitFor(() => follower.connected, 5000, 'connected');

      // Report this window's terminal (with the real shell pid), then arm agent.
      expect(await follower.reportTuples([tuple({ windowId: 'winA', pid, agentType: 'claude' })])).toBe(true);
      expect(await follower.armAgent(pid, 'claude', undefined)).toBe(true);

      // The leader's single detector probes the pid and broadcasts shellReady...
      await waitFor(
        () => readinessFacts.some((f) => f.pid === pid && f.event === 'shellReady'),
        8000,
        'shellReady broadcast',
      );
      // ...then agentReady once the child is a stable idle TUI.
      await waitFor(
        () => readinessFacts.some((f) => f.pid === pid && f.event === 'agentReady'),
        15000,
        'agentReady broadcast',
      );
    } finally {
      sub();
      follower.stop();
      await host.stop();
    }
  }, 25000);
});
