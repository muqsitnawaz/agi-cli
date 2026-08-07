/**
 * Per-device account bindings: `~/.agents/devices/<host>/accounts.yaml`.
 *
 * A **binding** records which installed harness versions on THIS device should
 * run under a given label's account. It is deliberately a separate file from the
 * device's `agents.yaml` (which older CLIs rewrite) so a stale agents-cli cannot
 * erase the bindings — the same reasoning as the central registry.
 *
 * The value for `(label, harness)` is a list of version ids, or the single
 * marker `'*'` meaning "every installed version of this harness on this device"
 * (version-global auth — the whole harness is signed into one account here).
 *
 * The devices/ tree syncs fleet-wide, so a peer's bindings are read/written in
 * place by naming the device — mirroring how `device-config.ts` targets a peer.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import { getUserAgentsDir } from '../state.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { machineId } from '../machine-id.js';
import type { AgentId } from '../types.js';

/** The version list that means "all installed versions of this harness". */
export const ALL_VERSIONS_MARKER = '*';

/** Current on-disk schema version. */
export const ACCOUNT_BINDINGS_SCHEMA_VERSION = 1;

/** One label's per-harness version bindings on a device. */
export type LabelBindings = Partial<Record<AgentId, string[]>>;

/** The parsed per-device bindings file. */
export interface AccountBindings {
  version: number;
  /** Label name → { harness → version ids (or `['*']`) }. */
  bindings: Record<string, LabelBindings>;
}

const HEADER =
  '# agents-cli account bindings for this device — which installed harness\n' +
  '# versions run under each label. Managed by `agents accounts`; NOT rewritten\n' +
  '# by older CLIs (kept out of agents.yaml on purpose).\n';

/** Absolute path to a device's bindings file (defaults to this machine). */
export function accountBindingsPath(device?: string): string {
  return path.join(getUserAgentsDir(), 'devices', device ?? machineId(), 'accounts.yaml');
}

function emptyBindings(): AccountBindings {
  return { version: ACCOUNT_BINDINGS_SCHEMA_VERSION, bindings: {} };
}

/**
 * Read a device's bindings. Missing file → empty. Malformed/non-map → hard error
 * (a silent empty would let the next write wipe the device's bindings).
 */
export function readAccountBindings(device?: string): AccountBindings {
  const p = accountBindingsPath(device);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return emptyBindings();
    throw err;
  }
  const corrupted = (detail: string) =>
    new Error(`Account bindings corrupted at ${p}: ${detail}. Inspect and restore from backup.`);
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: any) {
    throw corrupted(err?.message ?? String(err));
  }
  if (parsed === null || parsed === undefined) return emptyBindings();
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corrupted(`expected a YAML map, got ${Array.isArray(parsed) ? 'a list' : JSON.stringify(parsed)}`);
  }
  const doc = parsed as Record<string, unknown>;
  const bindings: Record<string, LabelBindings> = {};
  const rawBindings = doc.bindings;
  if (rawBindings && typeof rawBindings === 'object' && !Array.isArray(rawBindings)) {
    for (const [label, perHarness] of Object.entries(rawBindings as Record<string, unknown>)) {
      if (!perHarness || typeof perHarness !== 'object' || Array.isArray(perHarness)) {
        throw corrupted(`label '${label}' is not a map of harness->versions`);
      }
      const cell: LabelBindings = {};
      for (const [harness, versions] of Object.entries(perHarness as Record<string, unknown>)) {
        if (!Array.isArray(versions) || versions.some((v) => typeof v !== 'string')) {
          throw corrupted(`label '${label}' harness '${harness}' must be a list of version strings`);
        }
        cell[harness as AgentId] = versions as string[];
      }
      bindings[label] = cell;
    }
  }
  const version = typeof doc.version === 'number' ? doc.version : ACCOUNT_BINDINGS_SCHEMA_VERSION;
  return { version, bindings };
}

/** Write a device's bindings atomically (sorted for stable diffs). */
export function writeAccountBindings(bindings: AccountBindings, device?: string): void {
  const p = accountBindingsPath(device);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const sorted: Record<string, LabelBindings> = {};
  for (const label of Object.keys(bindings.bindings).sort()) {
    const cell = bindings.bindings[label];
    const sortedCell: LabelBindings = {};
    for (const harness of Object.keys(cell).sort() as AgentId[]) {
      sortedCell[harness] = [...cell[harness]!].sort();
    }
    sorted[label] = sortedCell;
  }
  const body = { version: bindings.version || ACCOUNT_BINDINGS_SCHEMA_VERSION, bindings: sorted };
  atomicWriteFileSync(p, HEADER + yaml.stringify(body));
}

/**
 * Set a label's version binding for a harness. `['*']` (or a list containing the
 * marker) collapses to version-global. An empty list removes the binding.
 */
export function setBinding(
  bindings: AccountBindings,
  label: string,
  harness: AgentId,
  versions: string[],
): void {
  const cleaned = versions.map((v) => v.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    removeBinding(bindings, label, harness);
    return;
  }
  const value = cleaned.includes(ALL_VERSIONS_MARKER)
    ? [ALL_VERSIONS_MARKER]
    : [...new Set(cleaned)].sort();
  (bindings.bindings[label] ??= {})[harness] = value;
}

/** Remove a binding. With no harness, removes the whole label. Returns true when something changed. */
export function removeBinding(bindings: AccountBindings, label: string, harness?: AgentId): boolean {
  const cell = bindings.bindings[label];
  if (!cell) return false;
  if (harness === undefined) {
    delete bindings.bindings[label];
    return true;
  }
  if (cell[harness] === undefined) return false;
  delete cell[harness];
  if (Object.keys(cell).length === 0) delete bindings.bindings[label];
  return true;
}

/**
 * Which installed versions of `harness` are bound to `label` on this device.
 * `'*'` expands to all `installedVersions`; a version-list is intersected with
 * what is actually installed (a binding to a GC'd version resolves to nothing).
 */
export function resolveBoundVersions(
  bindings: AccountBindings,
  label: string,
  harness: AgentId,
  installedVersions: readonly string[],
): string[] {
  const bound = bindings.bindings[label]?.[harness];
  if (!bound || bound.length === 0) return [];
  if (bound.includes(ALL_VERSIONS_MARKER)) return [...installedVersions];
  return bound.filter((v) => installedVersions.includes(v));
}

/** The label a specific installed version is bound to on this device, or null. */
export function labelForVersion(
  bindings: AccountBindings,
  harness: AgentId,
  version: string,
): string | null {
  for (const [label, cell] of Object.entries(bindings.bindings)) {
    const bound = cell[harness];
    if (bound && (bound.includes(ALL_VERSIONS_MARKER) || bound.includes(version))) return label;
  }
  return null;
}
