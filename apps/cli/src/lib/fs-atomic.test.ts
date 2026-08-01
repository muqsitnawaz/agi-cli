/**
 * Tests for the cross-process file lock's synchronous heartbeat (RUSH-1975).
 *
 * proper-lockfile keeps a held lock alive by refreshing its lockfile mtime on a
 * setTimeout every `stale/2` — but that timer only fires when the event loop gets a
 * turn, so a fully synchronous critical section that outlives the stale window (the
 * scrypt-bound secrets rotation) would age past `stale` mid-hold and a peer could
 * break the lock as "stale" and interleave. `withFileLock` hands `fn` a `heartbeat()`
 * that bumps the lockfile mtime synchronously to close that window.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { withFileLock, ensureLockTarget, sleepSync } from './fs-atomic.js';

describe('withFileLock heartbeat', () => {
  it('a synchronous hold that outlives the stale window stays un-stealable when it heartbeats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-hb-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    try {
      let stole = false;
      let blocked = false;
      withFileLock(target, (heartbeat) => {
        // Hold ~125ms — well past the 50ms stale window — refreshing every 25ms.
        // Without the heartbeat the lock would age past `stale` and the peer below
        // would break it; with it, the peer must still see the lock HELD (fresh).
        for (let i = 0; i < 5; i++) { heartbeat(); sleepSync(25); }
        try {
          const release = lockfile.lockSync(target, { stale: 50 });
          release();
          stole = true;
        } catch {
          blocked = true;
        }
      }, { staleMs: 50, acquireTimeoutMs: 100 });
      expect(stole).toBe(false);
      expect(blocked).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a short hold needs no heartbeat — the lock is held for the whole critical section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-short-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    try {
      let blocked = false;
      withFileLock(target, () => {
        // A single fast read-modify-write, well inside the stale window: a peer must
        // find the lock held even though this callback never touches the heartbeat.
        try { const release = lockfile.lockSync(target, { stale: 5_000 }); release(); }
        catch { blocked = true; }
      });
      expect(blocked).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
