/**
 * Reaper for orphaned macOS keychain-helper processes and `agents` procs stuck
 * on a keychain call (RUSH-2232, Layer 3 of RUSH-2229).
 *
 * The failure it cleans up: a wedged `coreauthd` XPC hangs the signed keychain
 * helper (`Agents CLI.app`) mid-read. Before Layer 1 (RUSH-2231) bounded every
 * helper `spawnSync`, the parent `agents` process blocked forever; when that
 * parent then died, the helper reparented to PID 1 and kept hanging. Dozens of
 * such orphans plus their `<defunct>` zombies pile up and make the machine
 * sluggish. Layer 1 stops NEW pileups at the source; this reaper clears the
 * BACKLOG (and any straggler that outlives its bound), running from the daemon
 * on a 5-minute tick (the "one executor" rule — CLAUDE.md §Scheduling).
 *
 * The planner {@link planKeychainReap} is PURE (no `ps`, no clock, no kill) so
 * every reap class and every never-reap guard is unit-testable without a real
 * process. {@link reapOrphanedKeychainProcesses} is the thin impure shell: it
 * runs `ps` once, fingerprints only the pids it might act on with
 * {@link captureProcessStartTime} (pid-reuse guard), plans, and kills via
 * {@link killTree}. Mirrors `isExpiredPoolStray` (crabbox/lease.ts) in shape.
 */

import { spawnSync } from 'child_process';
import { captureProcessStartTime, killTree } from '../platform/index.js';
import { getInstalledKeychainHelperExecPath } from './install-helper.js';

/** Idle grace before an orphaned (PPID==1) helper is reaped — a helper mid-boot
 *  is not yet stuck. */
export const KEYCHAIN_ORPHAN_GRACE_SECS = 30;

/** Age (> Layer-1's 60s interactive timeout) at which a helper child of a LIVE
 *  parent counts as stuck: a healthy read returns well inside the bound, so a
 *  helper child this old means the parent's `spawnSync` is not returning. */
export const KEYCHAIN_STUCK_CHILD_SECS = 90;

/** One row of the `ps` snapshot the planner reasons over. Platform-agnostic so
 *  the planner is testable off darwin. */
export interface KeychainProcSnapshot {
  pid: number;
  ppid: number;
  /** Seconds since the process started (`ps` etime), or null if unparseable —
   *  an unknowable age is never old enough to reap (fail closed). */
  elapsedSecs: number | null;
  /** The executable path (`ps` comm), exact-matched against the helper path. */
  command: string;
  /** A stable start-time fingerprint for pid-reuse safety across sweeps
   *  ({@link captureProcessStartTime}), or null when it could not be captured —
   *  a proc with no fingerprint is NEVER reaped (fail closed). Only populated
   *  for pids the reaper might act on (helper procs and their parents). */
  startTime: string | null;
}

/** A stuck helper-child carried between sweeps to debounce a racy `ps` snapshot.
 *  `stage` advances: first sighting → `sighted` (no kill); still there next
 *  sweep → the child is killed and the record flips to `child-killed`, which
 *  survives ONE more sweep to allow escalating to a genuinely wedged parent. */
export interface KeychainReapCandidate {
  childPid: number;
  childStartTime: string;
  parentPid: number;
  parentStartTime: string | null;
  stage: 'sighted' | 'child-killed';
}

/** One process the plan says to kill this sweep. */
export interface KeychainReapKill {
  pid: number;
  startTime: string;
  role: 'orphaned-helper' | 'stuck-helper-child' | 'stuck-parent';
  reason: string;
}

export interface KeychainReapPlan {
  /** Processes to SIGKILL this sweep (children before parents by construction —
   *  a parent is only ever escalated on a LATER sweep than its child's kill). */
  kills: KeychainReapKill[];
  /** Candidates to feed back as `prevCandidates` on the next sweep. Bounded by
   *  the number of currently-stuck helper procs; never accumulates. */
  nextCandidates: KeychainReapCandidate[];
}

export interface KeychainReapOptions {
  orphanGraceSecs?: number;
  stuckChildSecs?: number;
}

/**
 * Decide which keychain-related processes to reap this sweep. Pure.
 *
 * Two conservative reap classes:
 *
 *  (a) Orphaned helper — a proc whose command exactly matches `helperPath`, with
 *      PPID==1 (its parent already died, so nothing will ever reap it) and an
 *      age past the idle grace. Reaped immediately (no debounce needed: PPID==1
 *      is a durable, unambiguous "orphaned" signal).
 *
 *  (b) Stuck parent's helper child — a helper proc with a LIVE parent (PPID!=1,
 *      the parent pid present in the snapshot) that is older than the stuck
 *      threshold. Two-sweep debounced against a racy `ps` snapshot: first
 *      sighting is only recorded; a second consecutive sighting kills the CHILD
 *      (which frees the parent's blocked `spawnSync`). If, a sweep after that,
 *      the SAME parent still owns an old helper child, the parent is genuinely
 *      wedged and is escalated (killed).
 *
 * Never reaped (fail closed): a proc with a null start-time fingerprint, a
 * command that is not an exact match for `helperPath`, or a normal `agents`
 * session that owns no keychain-helper child.
 */
export function planKeychainReap(
  snapshots: readonly KeychainProcSnapshot[],
  helperPath: string,
  prevCandidates: readonly KeychainReapCandidate[] = [],
  opts: KeychainReapOptions = {},
): KeychainReapPlan {
  const orphanGrace = opts.orphanGraceSecs ?? KEYCHAIN_ORPHAN_GRACE_SECS;
  const stuckSecs = opts.stuckChildSecs ?? KEYCHAIN_STUCK_CHILD_SECS;
  const kills: KeychainReapKill[] = [];
  const nextCandidates: KeychainReapCandidate[] = [];

  const byPid = new Map<number, KeychainProcSnapshot>();
  for (const s of snapshots) byPid.set(s.pid, s);
  const isHelper = (s: KeychainProcSnapshot | undefined): boolean => !!s && s.command === helperPath;

  const helpers = snapshots.filter((s) => s.command === helperPath);

  // (a) Orphaned helpers — immediate.
  for (const s of helpers) {
    if (s.ppid !== 1) continue;
    if (s.startTime === null) continue; // fail closed: no fingerprint, no kill
    if (s.elapsedSecs === null || s.elapsedSecs <= orphanGrace) continue;
    kills.push({
      pid: s.pid,
      startTime: s.startTime,
      role: 'orphaned-helper',
      reason: `orphaned keychain helper (PPID 1) alive ${s.elapsedSecs}s (> ${orphanGrace}s grace)`,
    });
  }

  // (b) Stuck helper children of a live parent — two-sweep debounced.
  for (const s of helpers) {
    if (s.ppid === 1) continue; // handled by (a)
    if (s.startTime === null) continue; // fail closed
    if (s.elapsedSecs === null || s.elapsedSecs <= stuckSecs) continue;
    const parent = byPid.get(s.ppid);
    if (!parent) continue; // parent not live in this snapshot — nothing to free
    const seen = prevCandidates.find(
      (c) => c.stage === 'sighted' && c.childPid === s.pid && c.childStartTime === s.startTime,
    );
    if (seen) {
      // Second consecutive sighting: kill the child, freeing the parent's
      // blocked spawnSync. Carry a record so a still-wedged parent escalates.
      kills.push({
        pid: s.pid,
        startTime: s.startTime,
        role: 'stuck-helper-child',
        reason: `keychain helper child of live agents pid ${s.ppid} stuck ${s.elapsedSecs}s (> ${stuckSecs}s), two sweeps`,
      });
      nextCandidates.push({
        childPid: s.pid,
        childStartTime: s.startTime,
        parentPid: s.ppid,
        parentStartTime: parent.startTime,
        stage: 'child-killed',
      });
    } else {
      // First sighting: record only, do not kill (debounce a racy snapshot).
      nextCandidates.push({
        childPid: s.pid,
        childStartTime: s.startTime,
        parentPid: s.ppid,
        parentStartTime: parent.startTime,
        stage: 'sighted',
      });
    }
  }

  // (b, escalation) A parent whose child we killed last sweep but which STILL
  // owns an old helper child is genuinely wedged — kill the parent. Pid-reuse
  // guarded on the parent's fingerprint; a recovered/exited parent is dropped.
  for (const c of prevCandidates) {
    if (c.stage !== 'child-killed') continue;
    const parent = byPid.get(c.parentPid);
    if (!parent) continue; // parent gone — it recovered or exited
    if (parent.startTime === null || parent.startTime !== c.parentStartTime) continue; // reuse: fail closed
    const stillStuck = snapshots.some(
      (h) =>
        h.ppid === c.parentPid &&
        isHelper(h) &&
        h.startTime !== null &&
        h.elapsedSecs !== null &&
        h.elapsedSecs > stuckSecs,
    );
    if (stillStuck) {
      kills.push({
        pid: c.parentPid,
        startTime: parent.startTime,
        role: 'stuck-parent',
        reason: `agents pid ${c.parentPid} still wedged on a keychain read a sweep after its helper child was killed`,
      });
    }
    // else: parent recovered — drop (do not re-carry).
  }

  return { kills, nextCandidates };
}

/**
 * `ps` etime → seconds. Format is `[[dd-]hh:]mm:ss`. Returns null on any shape
 * it does not recognize (an unknowable age fails closed in the planner).
 */
export function parseEtimeSecs(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const mins = parseInt(m[3], 10);
  const secs = parseInt(m[4], 10);
  return ((days * 24 + hours) * 60 + mins) * 60 + secs;
}

/**
 * Parse `ps -Ao pid=,ppid=,etime=,comm=` output. `comm` is LAST because on
 * darwin it is the full executable path and may contain spaces (the helper lives
 * under "Application Support/agents-cli/Agents CLI.app/…"); everything after the
 * three leading numeric/token columns is the command. Rows that don't parse are
 * skipped. `startTime` is left null here — the impure layer fills it in for only
 * the pids that might be acted on.
 */
export function parsePsSnapshot(out: string): KeychainProcSnapshot[] {
  const rows: KeychainProcSnapshot[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      elapsedSecs: parseEtimeSecs(m[3]),
      command: m[4],
      startTime: null,
    });
  }
  return rows;
}

export interface KeychainReapResult {
  /** How many processes were killed this sweep. */
  reaped: number;
  killed: KeychainReapKill[];
  /** Feed back as `prevCandidates` on the next sweep. */
  nextCandidates: KeychainReapCandidate[];
}

/**
 * Run one reap sweep. macOS only (the keychain helper exists only there); a
 * no-op returning an empty result on every other platform. Best-effort: a `ps`
 * failure yields an empty sweep, never throws — the daemon tick must not crash
 * on a flaky snapshot.
 */
export function reapOrphanedKeychainProcesses(
  prevCandidates: readonly KeychainReapCandidate[] = [],
  opts: KeychainReapOptions = {},
): KeychainReapResult {
  const empty: KeychainReapResult = { reaped: 0, killed: [], nextCandidates: [] };
  if (process.platform !== 'darwin') return empty;

  let out: string;
  try {
    const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,etime=,comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (ps.status !== 0 || typeof ps.stdout !== 'string') return empty;
    out = ps.stdout;
  } catch {
    return empty;
  }

  const helperPath = getInstalledKeychainHelperExecPath();
  const rows = parsePsSnapshot(out);

  // Fingerprint only the pids the planner might act on: helper procs and the
  // parents of helper procs. Everything else keeps startTime=null (ignored).
  const helperPids = new Set<number>();
  for (const r of rows) if (r.command === helperPath) helperPids.add(r.pid);
  const needFingerprint = new Set<number>(helperPids);
  for (const r of rows) if (helperPids.has(r.pid)) needFingerprint.add(r.ppid);

  const snapshots = rows.map((r) =>
    needFingerprint.has(r.pid) ? { ...r, startTime: captureProcessStartTime(r.pid) } : r,
  );

  const plan = planKeychainReap(snapshots, helperPath, prevCandidates, opts);
  for (const k of plan.kills) killTree(k.pid);
  return { reaped: plan.kills.length, killed: plan.kills, nextCandidates: plan.nextCandidates };
}
