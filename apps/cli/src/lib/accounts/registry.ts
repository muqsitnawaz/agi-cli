/**
 * The central, fleet-synced account-labels registry: `~/.agents/accounts.yaml`.
 *
 * It maps each logical label to at most one identity **fingerprint** per harness
 * — never a raw email or account id (see {@link accountFingerprint}). It is its
 * own top-level file, NOT a block inside `agents.yaml`, for two reasons:
 *
 *   - It rides the `~/.agents` git sync (`git add -A`, `agents repo push/pull`)
 *     fleet-wide with no extra wiring, exactly like the resources tree.
 *   - An older agents-cli that predates this feature rewrites `agents.yaml` but
 *     never touches `accounts.yaml`, so it cannot silently erase the registry.
 *
 * Invariants, enforced on every mutation:
 *   - A label has AT MOST ONE identity per harness (one fingerprint per cell).
 *   - An identity (harness + fingerprint) belongs to AT MOST ONE label — the
 *     same signed-in account cannot be two logical accounts at once.
 *   - Label names are lowercase `[a-z0-9]` with internal `-`/`_`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import { getUserAgentsDir } from '../state.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import type { AgentId } from '../types.js';

/** Current on-disk schema version of `accounts.yaml`. */
export const ACCOUNT_LABELS_SCHEMA_VERSION = 1;

/** One label's identity fingerprints, keyed by harness id. */
export type LabelIdentities = Partial<Record<AgentId, string>>;

/** The parsed central registry. */
export interface AccountLabelsRegistry {
  version: number;
  /** Label name → { harness → fingerprint }. */
  labels: Record<string, LabelIdentities>;
}

const HEADER =
  '# agents-cli account labels — fleet-synced logical account identities.\n' +
  '# Values are non-secret identity fingerprints (never raw emails). Managed by\n' +
  '# `agents accounts`; safe to version-control.\n';

/** Absolute path to the central registry (resolved at call-time for test HOMEs). */
export function accountLabelsPath(): string {
  return path.join(getUserAgentsDir(), 'accounts.yaml');
}

const LABEL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Throw when `name` is not a valid label id. */
export function assertValidLabelName(name: string): void {
  if (typeof name !== 'string' || !LABEL_NAME_RE.test(name) || name.length > 64) {
    throw new Error(
      `Invalid account label '${name}'. Use lowercase letters, digits, '-' or '_' (1-64 chars, starting alphanumeric).`,
    );
  }
}

function emptyRegistry(): AccountLabelsRegistry {
  return { version: ACCOUNT_LABELS_SCHEMA_VERSION, labels: {} };
}

/**
 * Read the central registry. A missing file is an empty registry (not an error).
 * A malformed or non-map file is a HARD error — silently starting empty would let
 * the next write wipe every label the fleet shares (same contract as the device
 * registry).
 */
export function readAccountLabels(): AccountLabelsRegistry {
  const p = accountLabelsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return emptyRegistry();
    throw err;
  }
  const corrupted = (detail: string) =>
    new Error(`Account labels registry corrupted at ${p}: ${detail}. Inspect and restore from backup.`);
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: any) {
    throw corrupted(err?.message ?? String(err));
  }
  if (parsed === null || parsed === undefined) return emptyRegistry();
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corrupted(`expected a YAML map, got ${Array.isArray(parsed) ? 'a list' : JSON.stringify(parsed)}`);
  }
  const doc = parsed as Record<string, unknown>;
  const labels: Record<string, LabelIdentities> = {};
  const rawLabels = doc.labels;
  if (rawLabels && typeof rawLabels === 'object' && !Array.isArray(rawLabels)) {
    for (const [label, identities] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (!identities || typeof identities !== 'object' || Array.isArray(identities)) {
        throw corrupted(`label '${label}' is not a map of harness->fingerprint`);
      }
      const cell: LabelIdentities = {};
      for (const [harness, fp] of Object.entries(identities as Record<string, unknown>)) {
        if (typeof fp !== 'string' || !fp) {
          throw corrupted(`label '${label}' harness '${harness}' has a non-string fingerprint`);
        }
        cell[harness as AgentId] = fp;
      }
      labels[label] = cell;
    }
  }
  const version = typeof doc.version === 'number' ? doc.version : ACCOUNT_LABELS_SCHEMA_VERSION;
  return { version, labels };
}

/** Write the central registry atomically (sorted for stable diffs). */
export function writeAccountLabels(reg: AccountLabelsRegistry): void {
  const p = accountLabelsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const sortedLabels: Record<string, LabelIdentities> = {};
  for (const label of Object.keys(reg.labels).sort()) {
    const cell = reg.labels[label];
    const sortedCell: LabelIdentities = {};
    for (const harness of Object.keys(cell).sort() as AgentId[]) sortedCell[harness] = cell[harness];
    sortedLabels[label] = sortedCell;
  }
  const body = { version: reg.version || ACCOUNT_LABELS_SCHEMA_VERSION, labels: sortedLabels };
  atomicWriteFileSync(p, HEADER + yaml.stringify(body));
}

/** The label that owns a given (harness, fingerprint) identity, or null. */
export function labelForFingerprint(
  reg: AccountLabelsRegistry,
  harness: AgentId,
  fingerprint: string,
): string | null {
  for (const [label, cell] of Object.entries(reg.labels)) {
    if (cell[harness] === fingerprint) return label;
  }
  return null;
}

/**
 * Attach a harness identity to a label in-memory, enforcing both uniqueness
 * invariants. Throws when the same fingerprint already belongs to a DIFFERENT
 * label (an identity cannot be two logical accounts). Re-attaching the same
 * fingerprint to the same label is idempotent. Overwriting a label's existing
 * identity for that harness with a new fingerprint is allowed (a re-attach after
 * the account changed) — the old fingerprint is simply replaced.
 */
export function setLabelIdentity(
  reg: AccountLabelsRegistry,
  label: string,
  harness: AgentId,
  fingerprint: string,
): void {
  assertValidLabelName(label);
  const owner = labelForFingerprint(reg, harness, fingerprint);
  if (owner && owner !== label) {
    throw new Error(
      `This ${harness} identity is already labeled '${owner}'. One identity can belong to only one label — ` +
        `run 'agents accounts detach ${owner} ${harness}' first, or reuse '${owner}'.`,
    );
  }
  (reg.labels[label] ??= {})[harness] = fingerprint;
}

/** Remove a harness identity from a label. Returns true when something was removed. */
export function removeLabelIdentity(
  reg: AccountLabelsRegistry,
  label: string,
  harness: AgentId,
): boolean {
  const cell = reg.labels[label];
  if (!cell || cell[harness] === undefined) return false;
  delete cell[harness];
  if (Object.keys(cell).length === 0) delete reg.labels[label];
  return true;
}

/** Rename a label. Throws when the source is unknown or the target already exists. */
export function renameLabel(reg: AccountLabelsRegistry, from: string, to: string): void {
  assertValidLabelName(to);
  if (!reg.labels[from]) throw new Error(`No account label '${from}'.`);
  if (reg.labels[to]) throw new Error(`Account label '${to}' already exists.`);
  reg.labels[to] = reg.labels[from];
  delete reg.labels[from];
}

/** Remove a label entirely. Returns true when it existed. */
export function removeLabel(reg: AccountLabelsRegistry, label: string): boolean {
  if (!reg.labels[label]) return false;
  delete reg.labels[label];
  return true;
}
