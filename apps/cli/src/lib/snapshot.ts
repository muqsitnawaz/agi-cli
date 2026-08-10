/**
 * `agents snapshot` — one-process fleet consumer snapshot.
 *
 * Consumers (Factory watchdog, menubar, fleet scripts) used to fork:
 *   agents view <agent> --json  × N harnesses
 *   agents sessions --active --json
 *   agents feed --json          (sometimes)
 *
 * That is N+2 process starts per poll tick. This module gathers the same
 * shapes in one invocation so poll count drops to 1 without redefining
 * `agents status` (which stays the UnifiedSyncStatus sync contract).
 *
 * Stores are not merged — inventory still comes from view, active rows from
 * sessions, blocks from feed. Only the reader is consolidated.
 */

import { machineId } from './machine-id.js';
import { listBlocks, type OpenBlock } from './feed.js';
import { computeAgentCounts, type FleetAgentCounts } from './fleet-status.js';
import type { AgentId } from './types.js';
import type { UnifiedSyncStatus } from './sync-status.js';
import type { ViewJsonAgent } from '../commands/view.js';
import type { HarnessRow } from './devices/harness-inventory.js';
import { ALL_AGENT_IDS, AGENTS } from './agents.js';

export interface SnapshotHarness {
  id: AgentId;
  name: string;
  cliCommand: string;
  modes: readonly string[];
  capabilities: Record<string, unknown>;
}

export interface SnapshotDevice {
  /** Canonical device name. */
  name: string;
  /** Effective registry profile after central config overlays. */
  profile: Record<string, unknown>;
  /** Effective device-scoped config, keyed by canonical yaml key. */
  config: Record<string, unknown>;
  /** Installed harness/account/quota eligibility rows. */
  harnesses: HarnessRow[];
  /** Newest eligibility verdict timestamp, ISO-8601. */
  capturedAt: string | null;
  freshness: {
    status: 'fresh' | 'stale' | 'unavailable';
    ageMs: number | null;
    unavailableReason: string | null;
  };
}

/** One open-block row in the optional feed summary (no full question bodies). */
export interface SnapshotFeedBlock {
  blockId: string;
  sessionId: string;
  host: string;
  runtime: string;
  kind?: OpenBlock['kind'];
  ticket?: string;
  pr?: string;
  questionCount: number;
  ts: string;
}

/** Compact feed slice for needs-you polls. */
export interface SnapshotFeedSummary {
  openBlocks: number;
  blocks: SnapshotFeedBlock[];
}

/** Active-session row as emitted by `sessions --active --json`. */
export type SnapshotSessionRow = {
  ticketId: string | null;
  project: string | null;
  prLink: string | null;
  viewingIn: string | null;
  [key: string]: unknown;
};

/**
 * Stable machine-readable contract for `agents snapshot --json`.
 * Bump `version` only on breaking shape changes.
 */
export interface FleetSnapshot {
  version: 1;
  /** Host that produced this snapshot (machineId). */
  host: string;
  /** ISO-8601 capture time. */
  capturedAt: string;
  /** Installed agent inventory — same shape as `agents view --json`. */
  inventory: ViewJsonAgent[];
  /** Native harness identity/capability catalog derived from AGENTS. */
  harnesses: SnapshotHarness[];
  /** Canonical per-device launch-readiness view. */
  devices: SnapshotDevice[];
  /** Live sessions — same row shape as `agents sessions --active --json`. */
  sessions: SnapshotSessionRow[];
  /** How many remote devices contributed sessions (0 when --local). */
  remoteDeviceCount: number;
  /** Running/live tallies derived from `sessions` (same as fleet-status). */
  agents: FleetAgentCounts;
  /** Present when --with-feed. */
  feed?: SnapshotFeedSummary;
  /** Present when --with-sync (UnifiedSyncStatus; does not replace `agents status`). */
  sync?: UnifiedSyncStatus;
}

export interface ComputeSnapshotOptions {
  /** Restrict inventory to one agent id. */
  agent?: AgentId;
  /** Local sessions only — no cross-machine SSH fan-out. Default true for cheap polls. */
  local?: boolean;
  /** Explicit host filter for the sessions gather (same semantics as sessions --active). */
  hosts?: string[];
  /** Include open feed-block summary. */
  withFeed?: boolean;
  /** Include UnifiedSyncStatus (opt-in; can be slower). */
  withSync?: boolean;
  /** Cap feed.blocks length (default 50). */
  feedLimit?: number;
}

/** Summarize open blocks for the snapshot feed slice. Pure / unit-testable. */
export function summarizeFeedBlocks(
  blocks: ReadonlyArray<OpenBlock>,
  limit = 50,
): SnapshotFeedSummary {
  const sorted = [...blocks].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const slice = sorted.slice(0, Math.max(0, limit));
  return {
    openBlocks: blocks.length,
    blocks: slice.map((b) => ({
      blockId: b.blockId,
      sessionId: b.sessionId,
      host: b.host,
      runtime: b.runtime,
      kind: b.kind,
      ticket: b.ticket,
      pr: b.pr,
      questionCount: b.questions?.length ?? 0,
      ts: b.ts,
    })),
  };
}

/**
 * Assemble a snapshot payload from already-gathered pieces. Pure so tests do
 * not need live process scans or network.
 */
export function assembleSnapshot(parts: {
  host: string;
  capturedAt: string;
  inventory: ViewJsonAgent[];
  harnesses?: SnapshotHarness[];
  devices?: SnapshotDevice[];
  sessions: SnapshotSessionRow[];
  remoteDeviceCount: number;
  feed?: SnapshotFeedSummary;
  sync?: UnifiedSyncStatus;
}): FleetSnapshot {
  return {
    version: 1,
    host: parts.host,
    capturedAt: parts.capturedAt,
    inventory: parts.inventory,
    harnesses: parts.harnesses ?? ALL_AGENT_IDS.map((id) => ({
      id,
      name: AGENTS[id].name,
      cliCommand: AGENTS[id].cliCommand,
      modes: AGENTS[id].capabilities.modes,
      capabilities: AGENTS[id].capabilities as unknown as Record<string, unknown>,
    })),
    devices: parts.devices ?? [],
    sessions: parts.sessions,
    remoteDeviceCount: parts.remoteDeviceCount,
    agents: computeAgentCounts(
      parts.sessions.map((s) => ({
        status: typeof s.status === 'string' ? s.status : undefined,
        context: typeof s.context === 'string' ? s.context : undefined,
        kind: typeof s.kind === 'string' ? s.kind : undefined,
      })),
    ),
    ...(parts.feed ? { feed: parts.feed } : {}),
    ...(parts.sync ? { sync: parts.sync } : {}),
  };
}

/**
 * Gather inventory + active sessions (+ optional feed/sync) in one process.
 * Default `local: true` keeps the common poll path free of SSH fan-out; pass
 * `local: false` (or hosts) to match full `sessions --active` fleet scope.
 */
export async function computeSnapshot(
  opts: ComputeSnapshotOptions = {},
): Promise<FleetSnapshot> {
  // Default local-only sessions (cheap poll). Explicit hosts → scoped fan-out.
  // local: false (from --all-hosts) → full sessions --active fan-out.
  const localOnly = opts.hosts?.length ? false : opts.local !== false;

  const [{ collectAgentsJson }, sessionsMod] = await Promise.all([
    import('../commands/view.js'),
    import('../commands/sessions.js'),
  ]);

  const inventoryP = collectAgentsJson(opts.agent);
  const sessionsP = sessionsMod.gatherActiveSessions({
    local: localOnly,
    hosts: opts.hosts,
  });

  const feedP = opts.withFeed
    ? Promise.resolve(summarizeFeedBlocks(listBlocks(), opts.feedLimit ?? 50))
    : Promise.resolve(undefined);

  const syncP = opts.withSync
    ? import('./sync-status.js').then((m) => m.computeSyncStatus())
    : Promise.resolve(undefined);

  // Device eligibility fans out independently from active sessions. Start it
  // in the same wave so --all-hosts pays one network deadline, not two.
  const devicesP = collectSnapshotDevices({
    agent: opts.agent,
    allHosts: !localOnly,
  });

  const [inventory, gathered, feed, sync, devices] = await Promise.all([
    inventoryP,
    sessionsP,
    feedP,
    syncP,
    devicesP,
  ]);

  const sessions = sessionsMod.serializeActiveSessionsForJson(
    gathered.sessions,
  ) as SnapshotSessionRow[];

  return assembleSnapshot({
    host: machineId(),
    capturedAt: new Date().toISOString(),
    inventory,
    devices,
    sessions,
    remoteDeviceCount: gathered.remoteDeviceCount,
    feed,
    sync,
  });
}

/** Gather canonical device profiles + eligibility without consumer-side joins. */
export async function collectSnapshotDevices(opts: {
  agent?: AgentId;
  allHosts: boolean;
  now?: number;
}): Promise<SnapshotDevice[]> {
  const now = opts.now ?? Date.now();
  const [{ loadDevices }, { resolveDeviceProfile }, deviceConfig, sshCommand, harnessInventory] = await Promise.all([
    import('./devices/registry.js'),
    import('./devices/resolve-profile.js'),
    import('./device-config.js'),
    import('../commands/ssh.js'),
    import('./devices/harness-inventory.js'),
  ]);
  const registry = await loadDevices();
  const self = machineId();
  const names = [...new Set([self, ...Object.keys(registry)])].sort();
  const results = opts.allHosts
    ? await sshCommand.collectFleetHarnesses({ agents: opts.agent ? [opts.agent] : undefined })
    : [{ host: self, rows: await harnessInventory.collectLocalHarnessInventory({ agents: opts.agent ? [opts.agent] : undefined }) }];
  const byHost = new Map(results.map((result) => [result.host, result]));

  return names.map((name) => {
    const result = byHost.get(name);
    const rows = result?.rows ?? [];
    const capturedMs = rows.reduce((latest, row) => Math.max(latest, row.capturedAt ?? 0), 0);
    const quotaCaptured = rows
      .map((row) => row.quota.capturedAt)
      .filter((value): value is number => typeof value === 'number' && value > 0);
    const oldestDataMs = quotaCaptured.length > 0 ? Math.min(...quotaCaptured) : capturedMs;
    const ageMs = oldestDataMs > 0 ? Math.max(0, now - oldestDataMs) : null;
    const unavailableReason = result?.error ?? result?.skipped ?? (!result ? 'not requested' : null);
    const config: Record<string, unknown> = {};
    for (const entry of deviceConfig.listConfig({ device: name })) {
      if (entry.spec.scope === 'device' && entry.value !== undefined) config[entry.spec.yamlKey] = entry.value;
    }
    const profile = registry[name]
      ? resolveDeviceProfile(registry[name]) as unknown as Record<string, unknown>
      : { name };
    return {
      name,
      profile,
      config,
      harnesses: rows,
      capturedAt: capturedMs > 0 ? new Date(capturedMs).toISOString() : null,
      freshness: {
        status: unavailableReason ? 'unavailable' as const : rows.some((row) => row.quota.stale) ? 'stale' as const : 'fresh' as const,
        ageMs,
        unavailableReason,
      },
    };
  });
}
