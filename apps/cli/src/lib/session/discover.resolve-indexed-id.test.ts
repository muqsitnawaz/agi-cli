/**
 * `resolveIndexedSessionById` is the crash-restart resume-by-id fast path
 * (RUSH-2477). It MUST resolve a known id from the local WAL index alone —
 *
 *   1. with NO incremental discovery scan, so none of `tryClaimScan` /
 *      `releaseScan`'s `BEGIN IMMEDIATE` writer transactions fire and dozens of
 *      concurrent resumes never contend the writer lock into `SQLITE_BUSY`
 *      ("database is locked"), the crash the storm produced; and
 *   2. with NO fleet SSH fan-out — it touches only the SQLite reader, so a boot
 *      before the tailnet is up cannot hang or print the doubled
 *      "unreachable ... skipped" list.
 *
 * The concurrency test is the acceptance criterion: >= 20 simultaneous
 * indexed-id resolutions complete with zero throws.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the DB under a temp HOME BEFORE db.js/state.js capture it at import
// time (same hermetic pattern as discover.origin-machine.test.ts).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resolve-idx-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'this-box';

const dbModule = await import('./db.js');
const { upsertSession, closeDB } = dbModule;
const { resolveIndexedSessionById } = await import('./discover.js');
type SessionMeta = import('./types.js').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: path.join(TEST_HOME, '.claude', 'projects', 'p', `${id}.jsonl`),
    machine: 'this-box',
    ...extra,
  };
}

const IDS = Array.from({ length: 24 }, (_, i) =>
  `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444`,
);

describe('resolveIndexedSessionById', () => {
  it('resolves an exact full id from the index', async () => {
    upsertSession(meta(IDS[0]), '{}\n');
    const rows = await resolveIndexedSessionById(IDS[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(IDS[0]);
  });

  it('resolves an id prefix, and prefers exact over prefix siblings', async () => {
    // Two ids sharing an 8-char prefix; the full id must not also match its sibling.
    const a = 'abcd1234-0000-0000-0000-000000000001';
    const b = 'abcd1234-0000-0000-0000-000000000002';
    upsertSession(meta(a), '{}\n');
    upsertSession(meta(b), '{}\n');
    const exact = await resolveIndexedSessionById(a);
    expect(exact.map((r) => r.id)).toEqual([a]);
    const prefix = await resolveIndexedSessionById('abcd1234');
    expect(prefix.map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it('returns [] on a genuine miss (caller falls back to the fleet resolver)', async () => {
    expect(await resolveIndexedSessionById('ffffffff-dead-dead-dead-deaddeaddead')).toEqual([]);
    expect(await resolveIndexedSessionById('   ')).toEqual([]);
  });

  it('takes no scan claim — a resolve leaves the scan slot free for the real scanner', async () => {
    upsertSession(meta(IDS[1]), '{}\n');
    await resolveIndexedSessionById(IDS[1]);
    await resolveIndexedSessionById('nope-not-here');
    // The write-heavy path claims the scan slot (BEGIN IMMEDIATE) before scanning;
    // the fast path must not, so the slot is still free afterwards. If it had been
    // taken and not released, this claim would fail.
    expect(dbModule.tryClaimScan(process.pid)).toBe(true);
    dbModule.releaseScan(process.pid);
  });

  it('resolves >= 20 ids concurrently with zero SQLITE_BUSY / database-is-locked', async () => {
    for (const id of IDS) upsertSession(meta(id), '{}\n');
    // Fire every resolve at once — the crash-restart storm. Before the fast path,
    // each resume ran discoverSessions -> tryClaimScan (BEGIN IMMEDIATE), and 20+
    // concurrent writers exhausted busy_timeout and threw unhandled SQLITE_BUSY.
    const results = await Promise.allSettled(IDS.map((id) => resolveIndexedSessionById(id)));
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toEqual([]);
    for (let i = 0; i < IDS.length; i++) {
      const r = results[i];
      expect(r.status).toBe('fulfilled');
      if (r.status === 'fulfilled') expect(r.value.map((s) => s.id)).toEqual([IDS[i]]);
    }
  });

  it('never dials the fleet — zero SSH fan-out on an indexed resolve', async () => {
    // The acceptance criterion: a direct indexed id issues no fleet SSH fan-out
    // (no doubled "unreachable … skipped" list, no boot-time hang). Spy on the
    // real fan-out entry point and the recovery peer-hop; neither may fire.
    const remote = await import('./remote-list.js');
    const fanOut = vi.spyOn(remote, 'gatherRemoteList');
    const peerHop = vi.spyOn(remote, 'runOnPeer');
    upsertSession(meta(IDS[2]), '{}\n');
    await resolveIndexedSessionById(IDS[2]);
    await resolveIndexedSessionById('ffffffff-0000-0000-0000-000000000000'); // a miss
    expect(fanOut).not.toHaveBeenCalled();
    expect(peerHop).not.toHaveBeenCalled();
    fanOut.mockRestore();
    peerHop.mockRestore();
  });
});
