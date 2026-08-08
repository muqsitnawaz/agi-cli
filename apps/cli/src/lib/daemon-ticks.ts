/**
 * Daemon housekeeping ticks — one-shot bodies invoked by system routines.
 *
 * RUSH-2353: these were ~15 hardcoded `setInterval` timers inside
 * `runDaemon()` (daemon.ts) — a parallel, inferior reimplementation of the
 * routines system (no declaration, no run history, no pause/disable, no
 * device pin). Each function here is one migrated tick's *body*, unchanged in
 * behavior, now invoked as a detached one-shot process by a system routine's
 * `command:` (via the `agents __daemon-tick <name>` entrypoint in index.ts)
 * instead of an in-process interval closure.
 *
 * Overlap protection that used to live in daemon.ts as a per-tick boolean
 * flag (`watchdogInFlight`, `probingDevices`, ...) is now provided by the
 * routine runner's launch claim (`withRoutineLaunchClaim` in runner.ts) — two
 * fires of the same routine name never run concurrently.
 *
 * Output goes to `console.log`/`console.error`: each tick runs as a spawned
 * child of `executeCommandJobDetached`, which redirects the child's stdout to
 * the run's `stdout.log` — so this doubles as the run's log, readable via
 * `agents routines runs <name>`.
 */

import { readFileSync } from 'fs';
import { getConfigValue } from './device-config.js';

/** ~every 3 min. Mirrors the old WATCHDOG_TICK_MS. */
export async function runWatchdogTick(): Promise<void> {
  if (getConfigValue('watchdog.enabled').value !== true) {
    console.log('watchdog: disabled (watchdog.enabled != true) — skipping');
    return;
  }
  const { runWatchdogPass } = await import('./watchdog/service.js');
  const result = await runWatchdogPass({ nudge: true });
  console.log(`watchdog: ${result.counts.total} live, ${result.counts.stalled} stalled, ${result.counts.nudged} nudged`);
}

/**
 * Device probe: refresh registered devices' reachability and detect newly
 * appeared tailnet nodes, dropping a sentinel per pending device so the
 * menu-bar helper can surface "NEW DEVICES -> Register / Ignore". Refresh
 * mode never auto-registers a newcomer. A machine without tailscale is a
 * clean no-op. ~every 3 min.
 */
export async function runDeviceProbeTick(): Promise<void> {
  const { runDeviceSync } = await import('./devices/sync.js');
  const { reconcilePendingSentinels } = await import('./devices/pending.js');
  const dev = await runDeviceSync({ soft: true, mode: 'refresh' });
  if (!dev.ok) {
    console.log('device probe: sync not ok — skipping sentinel reconcile');
    return;
  }
  reconcilePendingSentinels(dev.pending);
  if (dev.pending.length) {
    console.log(`devices: ${dev.pending.length} new pending (${dev.pending.map((p) => p.name).join(', ')})`);
  } else {
    console.log('device probe: no new pending devices');
  }
}

/**
 * tmux hook reconcile: retrofit the guarded `pane-died` hook onto managed
 * `agents run` sessions a pre-fix binary left with the old unconditional
 * hook. Non-destructive: set-hook only, never a kill or detach. ~every 5 min.
 */
export async function runTmuxReconcileTick(): Promise<void> {
  const { isTmuxInstalled } = await import('./tmux/binary.js');
  if (!isTmuxInstalled()) {
    console.log('tmux reconcile: tmux not installed — skipping');
    return;
  }
  const { reconcileSessionHooks } = await import('./tmux/session.js');
  const r = await reconcileSessionHooks();
  console.log(`tmux: retrofitted pane-died hook on ${r.reconciled} session(s)`);
}

/**
 * Launch-health self-heal: probe that each agent's DEFAULT version actually
 * LAUNCHES, and repair a gutted install. Never repoints the global default
 * (allowDefaultSwitch: false) — a background default switch would be a
 * silent logout. ~every 6h.
 */
export async function runLaunchHealthTick(): Promise<void> {
  const { healBrokenDefaultLaunches } = await import('./versions.js');
  const { repaired, unhealed } = await healBrokenDefaultLaunches(
    (m) => console.log(`launch-health: ${m}`),
    { allowDefaultSwitch: false },
  );
  if (repaired.length) console.log(`launch-health: repaired ${repaired.join(', ')}`);
  if (unhealed.length) {
    console.log(`launch-health: ${unhealed.join(', ')} won't launch and will not be auto-switched — choose a version with \`agents use <agent> <version>\` or \`agents add <agent>@latest\``);
  }
  if (!repaired.length && !unhealed.length) console.log('launch-health: all default launches healthy');
}

/**
 * Fleet cache warm: publish THIS host's row for the caches `agents fleet
 * status` / `agents devices list` read (PUBLISH-OWN / READ-UNION, RUSH-2061).
 * ~every 3 min.
 */
export async function runFleetCacheWarmTick(): Promise<void> {
  const { machineId } = await import('./machine-id.js');
  const self = machineId();
  const { probeLocalFleetAuth, writeFleetAuthRows } = await import('./auth-health.js');
  const { getCliVersion } = await import('./version.js');
  const authRows = await probeLocalFleetAuth({ cliVersion: getCliVersion() });
  writeFleetAuthRows(self, authRows);

  const { publishLocalFleetStatus } = await import('./fleet-status.js');
  const row = await publishLocalFleetStatus(self);
  console.log(`fleet cache warm: ${authRows.length} auth row(s), ${row.agents.running} running agent(s) on ${self}`);
}

/**
 * Session-status cache warm (RUSH-2062): publish THIS host's local active
 * sessions so menubar / Factory / watchdog / CLI share one warm snapshot.
 * Publish-own only (no cross-host SSH). ~every 3 min.
 */
export async function runSessionCacheWarmTick(): Promise<void> {
  const { publishLocalActiveSessions } = await import('./session/session-cache.js');
  const r = await publishLocalActiveSessions();
  console.log(`session cache warm: ${r.sessions.length} local session(s)`);
}

/**
 * Usage refresh: keep the usage cache the `agents run` router reads
 * (RUSH-2061, readOnly hot path) fresh, WITHOUT the hot path ever fetching.
 * This host is the sole writer for its own local accounts. ~every 60s
 * (USAGE_REFRESH_TICK_MS in usage-refresh.ts — keep in sync).
 */
export async function runUsageRefreshTick(): Promise<void> {
  const { runUsageRefresh, buildLocalUsageAccounts } = await import('./usage-refresh.js');
  const { writeClaudeUsageCache } = await import('./usage.js');
  const { usageRateLimitedUntil } = await import('./usage-backoff.js');
  const r = await runUsageRefresh({
    listAccounts: buildLocalUsageAccounts,
    writeUsageCache: writeClaudeUsageCache,
    backoffUntil: usageRateLimitedUntil,
  });
  console.log(
    `usage refresh: ${r.refreshed} refreshed, ${r.failed} failed, ${r.skippedNotDue} not-due, ${r.skippedBackoff} backed-off, ${r.skippedCap} capped`,
  );
}

/**
 * Auto-dispatch: for any managed project that has opted in (autoDispatch:true
 * + maxAgents>0 in ~/.agents/factory/projects.json), pick up Linear tickets
 * delegated to an agent and still in Todo, and dispatch each through
 * agents-cli's own cloud-provider layer. OFF unless a project opts in; no
 * opted-in project or no LINEAR_API_KEY is a clean no-op. ~every 3 min.
 *
 * Migrated to a routine (RUSH-2353) so it inherits the `devices:` allowlist —
 * pin with `agents routines devices auto-dispatch --set <one>` to fix the
 * shared-input double-fire problem this job had hardcoded (every daemon on
 * the fleet polled the same Linear queue with no coordination).
 */
export async function runAutoDispatchTick(): Promise<void> {
  const { readAutoDispatchProjects, isEligible, autoDispatchTick } = await import('./auto-dispatch.js');
  const projects = readAutoDispatchProjects();
  if (!projects.some(isEligible)) {
    console.log('auto-dispatch: no opted-in project — skipping');
    return;
  }
  const { createLinearGateway } = await import('./auto-dispatch-linear.js');
  const linear = createLinearGateway();
  if (!linear) {
    console.log('auto-dispatch: no LINEAR_API_KEY configured — skipping');
    return;
  }
  const { createProviderDispatcher } = await import('./auto-dispatch-provider.js');
  const dispatcher = createProviderDispatcher();
  const dispatched = await autoDispatchTick({
    projects,
    linear,
    dispatcher,
    log: (lvl, m) => (lvl === 'ERROR' ? console.error(m) : console.log(m)),
  });
  if (dispatched.length) {
    console.log(`auto-dispatch: started ${dispatched.length} delegated ticket(s): ${dispatched.map((d) => d.identifier).join(', ')}`);
  } else {
    console.log('auto-dispatch: no delegated tickets to dispatch');
  }
}

/** Registry: routine-facing name -> tick body. Keys match the shipped routine YAML names. */
export const DAEMON_TICKS: Record<string, () => Promise<void>> = {
  watchdog: runWatchdogTick,
  'device-probe': runDeviceProbeTick,
  'tmux-reconcile': runTmuxReconcileTick,
  'launch-health': runLaunchHealthTick,
  'fleet-cache-warm': runFleetCacheWarmTick,
  'session-cache-warm': runSessionCacheWarmTick,
  'usage-refresh': runUsageRefreshTick,
  'auto-dispatch': runAutoDispatchTick,
};

export const DAEMON_TICK_ROUTINE_NAMES = Object.freeze(Object.keys(DAEMON_TICKS));

/** Run one named tick, or throw for an unknown name (fails the routine run loud). */
export async function runDaemonTick(name: string): Promise<void> {
  const fn = DAEMON_TICKS[name];
  if (!fn) {
    throw new Error(`Unknown daemon tick '${name}'. Known: ${Object.keys(DAEMON_TICKS).join(', ')}`);
  }
  await fn();
}

// ─── In-process daemon ticks (NOT routine-invoked) ──────────────────────────
//
// Everything above is a one-shot body a shipped system routine invokes through
// `agents __daemon-tick <name>`, and is registered in DAEMON_TICKS. The four
// below are deliberately absent from that registry: each closes over
// daemon-lifetime state (the hosted broker handle, this daemon's lifetime
// token) or must be able to shut the daemon down, none of which survives into a
// separate one-shot process. They stay in-process — but their bodies do not
// belong inline in a 490-line runDaemon(), so they live here too and take their
// dependencies explicitly. runDaemon keeps the wiring: the intervals, the
// re-entrancy flags, and the shutdown hook.

/** The daemon's structured logger (`log` in daemon.ts), injected. */
export type DaemonLog = (level: string, message: string) => void;

/**
 * RUSH-1817: decide whether the daemon should (re)take over hosting the secrets
 * broker. The startup host decision is one-shot; this drives the periodic
 * self-heal re-check. Take over ONLY when the daemon is not already hosting AND
 * no healthy broker answers a ping — i.e. a standalone the daemon deferred to at
 * start has since died or crash-looped. Never take over while our in-process
 * broker is hosting, and never clobber a reachable (healthy) broker.
 *
 * Lives here with the tick that uses it (and is re-exported from daemon.ts for
 * its existing importers), because daemon.ts imports this module — importing
 * back would be a cycle.
 */
export function shouldTakeOverBroker(isHosting: boolean, brokerReachable: boolean): boolean {
  return !isHosting && !brokerReachable;
}

/**
 * Resource safety check: heal gaps between what DotAgents repos define and what
 * is actually installed in each agent home — the slow rot nothing else catches
 * (a non-default version left stale, a Claude-invalid plugin manifest silently
 * rejecting a whole plugin). Conservative 'safe' mode: fills missing resources,
 * repairs invalid manifests, fast-forwards provably-unmodified stale plugins,
 * but never overwrites hand-edited content or a plugin it cannot prove pristine
 * — those it reports for `doctor --fix`. Silent by design; the log is the record.
 *
 * `stateDirExists` is checked twice on purpose: the daemon's state dir is its
 * liveness boundary, and once that tree is removed background maintenance must
 * not recreate it while the self-terminate guard is shutting the process down.
 */
export async function runSelfHealTick(deps: { log: DaemonLog; stateDirExists: () => boolean }): Promise<void> {
  if (!deps.stateDirExists()) return;
  try {
    const { runSelfHeal, selfHealChangedAnything, selfHealNeedsAttention, summarizeSelfHeal } =
      await import('./self-heal/registry.js');
    if (!deps.stateDirExists()) return;
    const report = await runSelfHeal({ mode: 'safe' });
    if (selfHealChangedAnything(report) || selfHealNeedsAttention(report)) {
      deps.log('INFO', `self-heal: ${summarizeSelfHeal(report)}`);
    }
  } catch (err) {
    deps.log('ERROR', `self-heal check failed: ${(err as Error).message}`);
  }
}

/**
 * RUSH-1817: the startup host decision is one-shot. If a standalone broker
 * answered `agentPing()` at daemon start, the daemon declined to host — but
 * should that standalone later die or crash-loop, nothing takes over and every
 * `agents secrets unlock|export|start` fails until a manual restart (this wedged
 * all keychain-backed secrets on zion and blocked a release). Re-probe on a
 * cadence and take over when no healthy broker answers. `startHostedBroker`
 * binds the socket only when it is free, so a take-over never races a live one.
 */
export async function runBrokerSelfHealTick(deps: {
  log: DaemonLog;
  isHosting: () => boolean;
  onHosted: (broker: unknown) => void;
}): Promise<void> {
  try {
    const { agentPing, startHostedBroker } = await import('./secrets/agent.js');
    const reachable = (await agentPing()).reachable;
    if (!shouldTakeOverBroker(deps.isHosting(), reachable)) return;
    const broker = await startHostedBroker();
    if (broker) {
      deps.onHosted(broker);
      deps.log('WARN', 'Secrets broker was unreachable; daemon took over hosting (self-heal)');
    }
  } catch (err) {
    deps.log('WARN', `Secrets broker self-heal skipped: ${(err as Error).message}`);
  }
}

/**
 * RUSH-2232: reap orphaned keychain helpers and `agents` processes stuck on a
 * keychain call. Runs in the daemon (the single executor) so no UI surface can
 * race it. The reaper shells `ps` once, plans kills in a pure function, and
 * executes via killTree.
 */
export async function runKeychainReapTick(deps: { log: DaemonLog }): Promise<void> {
  try {
    const { reapOrphanedKeychainProcesses } = await import('./secrets/reaper.js');
    const result = reapOrphanedKeychainProcesses();
    if (result.reaped > 0) {
      deps.log('WARN', `Reaped ${result.reaped} keychain orphan/stuck process(es)`);
      for (const d of result.details) deps.log('WARN', `  ${d}`);
    }
  } catch (err) {
    deps.log('ERROR', `Keychain reaper failed: ${(err as Error).message}`);
  }
}

/**
 * RUSH-2367: self-terminate if this daemon's own state dir has been removed out
 * from under it — the shape of a leaked test-fixture daemon whose /tmp HOME was
 * deleted by its test's own cleanup while the process survived (lost the
 * SIGTERM/SIGKILL race, or outlived a killed test runner before its `finally`
 * ever ran). Nothing else can reach a daemon in that state: no `agents daemon`
 * command targets it, since a different HOME resolves a different state dir and
 * therefore a different instance registry — without this it runs forever.
 *
 * Reads the lifetime marker path DIRECTLY. It must never route through a helper
 * that creates the directory as a side effect (`ensureDaemonDir` in daemon.ts),
 * which would recreate the very tree whose absence is being detected. Heartbeat
 * and status paths may recreate the directory and pid file after a deletion;
 * they never recreate this per-lifetime token.
 */
export function runStateDirSelfCheckTick(deps: {
  log: DaemonLog;
  lifetimePath: string;
  lifetimeToken: string;
  stateDir: string;
  onStale: () => void;
}): void {
  let markerMatches = false;
  try {
    markerMatches = readFileSync(deps.lifetimePath, 'utf-8') === deps.lifetimeToken;
  } catch {
    // A missing state tree or marker is the condition this guard detects.
  }
  if (markerMatches) return;
  deps.log('WARN', `Daemon state dir ${deps.stateDir} no longer exists; exiting (self-terminate guard)`);
  deps.onStale();
}
