/**
 * Placement scheduler for distributed teams.
 *
 * Decides WHERE an unpinned teammate runs, resolving the create→pin→pool→local
 * cascade from the team's device pool and the live roster. Kept pure and
 * I/O-free (plain data in, a device name or null out) so it is trivially
 * testable and can be called from the hot launch path without SSH round-trips.
 *
 *   1. teammate has an explicit `--device` pin      → that device
 *   2. else the team pool has exactly one device     → that device (whole team)
 *   3. else the team pool has many devices           → health-aware pick
 *   4. else (no pin, no pool)                         → null == run local
 *
 * Step 3 is cap-aware: a device at its `agents.max-concurrent` cap (from the
 * device doc, passed in via PlacementOptions) is excluded from the auto-pick,
 * and an all-capped pool fails loud. When the caller also passes live fleet
 * data (`health` + `harness` in PlacementOptions), step 3 upgrades from a pure
 * roster-count to {@link pickHealthiest}: it drops unreachable, overloaded, and
 * harness-incapable boxes, then ranks by harness availability, load/memory, and
 * running-teammate count — failing loud when no box in the pool can run the
 * requested agent. With no fleet data it falls back to {@link pickLeastLoaded},
 * so a caller with nothing to pass keeps the old behaviour. Pins and pools of
 * one are the user's own choice and are never second-guessed.
 *
 * A device whose name equals the local machine id is treated as "local" — it
 * resolves to a null placement so the existing local spawn path runs unchanged,
 * letting the local machine participate in a pool as just another member.
 */
import { machineId } from '../session/sync/config.js';
import type { Headroom } from '../devices/health.js';

/** Team fields the placement cascade reads (a subset of TeamMeta). */
export interface PlacementTeam {
  devices?: string[];
}

/**
 * Per-device health the health-aware pick reads (a projection of `DeviceStats`
 * + its computed `headroom` bucket). Every field is optional so a cold stats
 * cache degrades to the old least-loaded behaviour rather than excluding a
 * device it has no data for. Passed in by the caller (agents.ts), which owns
 * the SSH/cache I/O; this module stays pure.
 *
 * - `reachable: false`      → excluded (unreachable box).
 * - `headroom: 'loaded'`    → excluded (overloaded box).
 * - `loadPercent`/`memPercent` → the "lower is better" ranking signal (b).
 */
export interface DeviceHealthInput {
  reachable?: boolean;
  headroom?: Headroom;
  loadPercent?: number;
  memPercent?: number;
}

/**
 * Whether the requested harness (agent, and its pinned version when given) can
 * run on a device, derived from the fleet auth-health cache:
 *
 * - `available`   — installed AND signed in (a non-revoked cached auth row).
 * - `unavailable` — provably cannot: the box was probed and the agent is absent
 *                   or only holds a revoked token. Excluded from selection, and
 *                   an all-`unavailable` pool fails loud.
 * - `unknown`     — no cached data for that box (never probed). NOT excluded —
 *                   a cold cache must never manufacture a false "can't run" —
 *                   just ranked after a proven-`available` device.
 */
export type HarnessAvailability = 'available' | 'unavailable' | 'unknown';

/**
 * Optional placement inputs beyond the team + roster. `maxConcurrent` maps a
 * device name to its `agents.max-concurrent` cap (from the device doc — read
 * locally via `readMaxConcurrentCaps`, never probed over SSH). Teams counts
 * the team's OWN roster against the cap (device-global counting would need an
 * SSH probe per candidate — out of the hot path; Factory auto-launch is the
 * device-wide counter). Only the AUTO-PICK (cascade step 3) honors caps and
 * health: an explicit pin or a pool of one is the user's own choice and is
 * never second-guessed.
 *
 * `health` + `harness` upgrade step 3 from a pure roster-count to a
 * health-, load-, and harness-aware pick ({@link pickHealthiest}). When both
 * are absent the pick falls back to {@link pickLeastLoaded}, so a caller with
 * no fleet data keeps today's behaviour. `requestedLabel` (e.g.
 * `claude@2.1.112`) and `availabilityHint` shape the loud failure message.
 */
export interface PlacementOptions {
  maxConcurrent?: Record<string, number>;
  health?: Record<string, DeviceHealthInput>;
  harness?: Record<string, HarnessAvailability>;
  requestedLabel?: string;
  availabilityHint?: string;
}

/**
 * A roster entry the load counter reads — the shape any teammate satisfies
 * (AgentProcess included). `status` is compared against `'running'` (the
 * AgentStatus.RUNNING value) without importing the enum, keeping this leaf pure.
 */
export interface RosterEntry {
  hostName: string | null;
  status: string;
}

/** True when `device` names the local machine (case-insensitive). */
function isLocalDevice(device: string): boolean {
  return device.toLowerCase() === machineId();
}

/** Count RUNNING teammates per pool device. Pure. A null/empty hostName is a
 * LOCAL teammate — it counts against the pool member that is this machine,
 * otherwise a cap on the local device could never engage. */
function loadByDevice(devices: string[], roster: RosterEntry[]): Map<string, number> {
  const load = new Map<string, number>();
  for (const d of devices) load.set(d, 0);
  for (const r of roster) {
    if (r.status !== 'running') continue;
    const host = r.hostName ? r.hostName : devices.find((d) => isLocalDevice(d));
    if (!host) continue; // local teammate but this machine is not in the pool
    if (load.has(host)) load.set(host, (load.get(host) ?? 0) + 1);
  }
  return load;
}

/**
 * Pool devices excluded from auto-pick because they are at (or over) their
 * `agents.max-concurrent` cap. Returned with the live counts so the caller can
 * state the reason to the user instead of the device silently never winning.
 */
export function cappedDevices(
  devices: string[],
  roster: RosterEntry[],
  maxConcurrent: Record<string, number>,
): Array<{ device: string; running: number; cap: number }> {
  const load = loadByDevice(devices, roster);
  const capped: Array<{ device: string; running: number; cap: number }> = [];
  for (const d of devices) {
    const cap = maxConcurrent[d];
    if (cap === undefined) continue;
    const running = load.get(d) ?? 0;
    if (running >= cap) capped.push({ device: d, running, cap });
  }
  return capped;
}

/**
 * Pick the least-loaded device from the pool — the one with the fewest RUNNING
 * teammates currently assigned to it. Ties break by pool order (first wins), so
 * an empty pool fills round-robin-ish as teammates launch. Pure: counts the
 * roster, no I/O.
 *
 * With `maxConcurrent`, devices at their cap are excluded; if EVERY device is
 * capped this throws naming each cap and the fix — a loud failure beats a
 * teammate silently landing on a machine its operator capped.
 */
export function pickLeastLoaded(
  devices: string[],
  roster: RosterEntry[],
  maxConcurrent?: Record<string, number>,
): string {
  if (devices.length === 0) {
    throw new Error('pickLeastLoaded called with an empty device pool');
  }
  const load = loadByDevice(devices, roster);
  const capped = new Set(
    maxConcurrent ? cappedDevices(devices, roster, maxConcurrent).map((c) => c.device) : [],
  );
  const eligible = devices.filter((d) => !capped.has(d));
  if (eligible.length === 0) {
    const detail = devices
      .map((d) => `${d} (${load.get(d) ?? 0}/${maxConcurrent![d]})`)
      .join(', ');
    throw new Error(
      `Every device in the pool is at its agents.max-concurrent cap: ${detail}. ` +
        `Raise a cap with 'agents devices configure <name> --max-agents N' or add a device to the pool.`,
    );
  }
  // Iterate the pool in declared order so the first device wins ties.
  let best = eligible[0];
  let bestLoad = load.get(best) ?? 0;
  for (const d of eligible) {
    const l = load.get(d) ?? 0;
    if (l < bestLoad) {
      best = d;
      bestLoad = l;
    }
  }
  return best;
}

/** A representative load% for a bucket, used only when the precise loadPercent /
 * memPercent are both missing (a reachable box with no parsed stats). Keeps the
 * ranking numeric and total without letting a no-stats box always win or lose. */
const HEADROOM_MID: Record<Headroom, number> = {
  idle: 7,
  light: 27,
  busy: 57,
  unknown: 50,
  loaded: 90,
};

/** The "how full is this box" number: the worse of normalized load% and mem%,
 * or undefined when neither was parsed. Mirrors `health.ts` `headroom()`. */
function worstSignal(h: DeviceHealthInput | undefined): number | undefined {
  const signals = [h?.loadPercent, h?.memPercent].filter(
    (v): v is number => typeof v === 'number',
  );
  return signals.length ? Math.max(...signals) : undefined;
}

/** The numeric load score for ranking: precise worst-signal when known, else the
 * headroom bucket's representative midpoint. Always a number, so the sort is total. */
function loadScore(h: DeviceHealthInput | undefined): number {
  return worstSignal(h) ?? HEADROOM_MID[h?.headroom ?? 'unknown'];
}

/**
 * Health-, load-, and harness-aware pool pick (cascade step 3 when the caller
 * supplies fleet data). It:
 *
 *   1. excludes devices at their max-concurrent cap, unreachable, or overloaded
 *      (`headroom: 'loaded'`);
 *   2. excludes devices that provably can't run the requested harness
 *      (`harness[d] === 'unavailable'`) from selection;
 *   3. ranks the survivors by (a) harness availability (proven-installed +
 *      signed-in before unknown), (b) lower load/memory, (c) fewer running
 *      teammates, tie-broken by pool order.
 *
 * Fails loud, never silently, when nothing can run:
 *   - if every eligible device is a proven `unavailable`, the message names the
 *     requested harness and points at the availability command;
 *   - if no device is even eligible (all unreachable / overloaded / capped), the
 *     message names each drop reason.
 *
 * With no `health`/`harness` data this reduces to {@link pickLeastLoaded}: all
 * devices score equal on (a) and (b), so the pick collapses to fewest-running +
 * pool-order. Pure — counts the roster, reads the passed maps, no I/O.
 */
export function pickHealthiest(
  devices: string[],
  roster: RosterEntry[],
  opts: PlacementOptions = {},
): string {
  if (devices.length === 0) {
    throw new Error('pickHealthiest called with an empty device pool');
  }
  const load = loadByDevice(devices, roster);
  const health = opts.health ?? {};
  const harness = opts.harness ?? {};
  const label = opts.requestedLabel ?? 'the requested agent';
  const hint = opts.availabilityHint ?? 'agents fleet status --verbose';

  const capped = new Set(
    opts.maxConcurrent ? cappedDevices(devices, roster, opts.maxConcurrent).map((c) => c.device) : [],
  );

  // 1. Hard eligibility filter — track why each drop happened for the loud error.
  const excluded: Array<{ device: string; reason: string }> = [];
  const eligible: string[] = [];
  for (const d of devices) {
    if (capped.has(d)) {
      excluded.push({ device: d, reason: `at max-concurrent cap (${load.get(d) ?? 0}/${opts.maxConcurrent![d]})` });
    } else if (health[d]?.reachable === false) {
      excluded.push({ device: d, reason: 'unreachable' });
    } else if (health[d]?.headroom === 'loaded') {
      excluded.push({ device: d, reason: 'overloaded' });
    } else {
      eligible.push(d);
    }
  }

  // 2. Drop devices that provably can't run the harness. 'unknown' stays in —
  // a cold cache must not manufacture a false "can't run".
  const candidates = eligible.filter((d) => harness[d] !== 'unavailable');

  if (candidates.length === 0) {
    if (eligible.length > 0) {
      // Reachable, roomy boxes exist — they just can't run this harness.
      throw new Error(
        `No device in the team pool can run ${label} (checked ${eligible.join(', ')}). ` +
          `Run '${hint}' to see which harnesses each box has installed and signed in, ` +
          `or 'agents fleet login' to sign one in.`,
      );
    }
    const detail = excluded.length
      ? excluded.map((e) => `${e.device} (${e.reason})`).join(', ')
      : devices.join(', ');
    throw new Error(
      `No viable device in the team pool for ${label}: ${detail}. ` +
        `Free up a box, raise a cap with 'agents devices configure <name> --max-agents N', ` +
        `or add a device to the pool.`,
    );
  }

  // 3. Rank by the lexicographic key: availability, load, running count, pool order.
  const order = new Map(devices.map((d, i) => [d, i] as const));
  const availRank = (d: string): number => (harness[d] === 'available' ? 0 : 1);
  const key = (d: string): [number, number, number, number] => [
    availRank(d),
    loadScore(health[d]),
    load.get(d) ?? 0,
    order.get(d) ?? 0,
  ];
  // Numeric tuple compare — NOT array `<` (which stringifies and misorders
  // multi-digit numbers, e.g. "0,100" < "0,7"). First differing field decides.
  const lessThan = (a: [number, number, number, number], b: [number, number, number, number]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };
  let best = candidates[0];
  let bestKey = key(best);
  for (const d of candidates.slice(1)) {
    const k = key(d);
    if (lessThan(k, bestKey)) {
      best = d;
      bestKey = k;
    }
  }
  return best;
}

/**
 * Resolve where a teammate runs. Returns `{ device: null }` for a local run
 * (no pin, no pool, or the chosen device is the local machine) and
 * `{ device: <name> }` for a remote placement. See the cascade in the module
 * header.
 */
export function resolvePlacement(
  team: PlacementTeam,
  explicitDevice: string | null,
  roster: RosterEntry[],
  opts?: PlacementOptions,
): { device: string | null } {
  // 1. Explicit pin wins — even without a pool.
  if (explicitDevice) {
    return { device: isLocalDevice(explicitDevice) ? null : explicitDevice };
  }
  const pool = team.devices ?? [];
  // 4. No pool → local, exactly like today.
  if (pool.length === 0) return { device: null };
  // 2. Pool of one → the whole team runs there.
  if (pool.length === 1) {
    return { device: isLocalDevice(pool[0]) ? null : pool[0] };
  }
  // 3. Many → health-aware pick when the caller supplied fleet data, else the
  // pure least-loaded pick (both cap-aware when caps are provided).
  const picked =
    opts?.health || opts?.harness
      ? pickHealthiest(pool, roster, opts)
      : pickLeastLoaded(pool, roster, opts?.maxConcurrent);
  return { device: isLocalDevice(picked) ? null : picked };
}
