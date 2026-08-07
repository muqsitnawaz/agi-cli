/**
 * Resolve a logical account label to the installed harness version that is
 * actually signed into that identity — the fail-loud router shared by
 * `agents run --account <label>` and label-pinned routines.
 *
 * The contract (issue #2300): explicit label routing NEVER falls back to another
 * account. If no installed, correctly-signed-in version can serve the label, the
 * resolution FAILS with a reason — it does not quietly run under a different
 * account. Verification is by live identity: the candidate version's on-disk
 * credential is read fresh and its {@link accountFingerprint} compared to the
 * label's stored fingerprint, so a version that drifted to another account is
 * skipped, never trusted from the binding alone.
 */
import { getAccountInfo } from '../agents.js';
import type { AgentId } from '../types.js';
import {
  compareVersions,
  getGlobalDefault,
  getVersionHomePath,
  listInstalledVersions,
} from '../versions.js';
import { accountFingerprint, isLabelableAgent } from './capability.js';
import { readAccountLabels } from './registry.js';
import { readAccountBindings, resolveBoundVersions } from './bindings.js';

/** A successful label->version resolution. */
export interface AccountLabelHit {
  ok: true;
  version: string;
  fingerprint: string;
  /** Every installed version that verified against the label (the picked one first). */
  matches: string[];
}

/** A failed resolution, with a user-facing reason and a suggested fix. */
export interface AccountLabelMiss {
  ok: false;
  reason: string;
}

export type AccountLabelResolution = AccountLabelHit | AccountLabelMiss;

/**
 * Resolve `label` to a signed-in `agent` version on this device, or fail loud.
 *
 * Candidate versions come from the per-device binding when one exists (`'*'`
 * expands to all installed); with no binding, every installed version is a
 * candidate. Each candidate's live identity fingerprint must equal the label's
 * stored fingerprint — a bound-but-drifted version is skipped. Among the
 * verified matches the global default wins, else the newest.
 */
export async function resolveAccountLabel(
  agent: AgentId,
  label: string,
): Promise<AccountLabelResolution> {
  if (!isLabelableAgent(agent)) {
    return { ok: false, reason: `${agent} does not support account labels.` };
  }

  const registry = readAccountLabels();
  const cell = registry.labels[label];
  if (!cell) {
    const known = Object.keys(registry.labels).sort();
    return {
      ok: false,
      reason:
        `No account label '${label}'.` +
        (known.length ? ` Known labels: ${known.join(', ')}.` : ' Create one with: agents accounts label.'),
    };
  }
  const fingerprint = cell[agent];
  if (!fingerprint) {
    return {
      ok: false,
      reason:
        `Account label '${label}' has no ${agent} identity. ` +
        `Attach one: agents accounts attach ${label} ${agent}.`,
    };
  }

  const installed = listInstalledVersions(agent);
  if (installed.length === 0) {
    return { ok: false, reason: `No installed ${agent} versions. Run: agents add ${agent}@latest.` };
  }

  const bindings = readAccountBindings();
  const hasBinding = bindings.bindings[label]?.[agent] !== undefined;
  const candidates = hasBinding
    ? resolveBoundVersions(bindings, label, agent, installed)
    : [...installed];

  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        `Account label '${label}' is bound to ${agent} versions that are not installed on this device. ` +
        `Re-bind: agents accounts attach ${label} ${agent}.`,
    };
  }

  const matches: string[] = [];
  for (const version of candidates) {
    const info = await getAccountInfo(agent, getVersionHomePath(agent, version)).catch(() => null);
    if (info && accountFingerprint(agent, info) === fingerprint) matches.push(version);
  }

  if (matches.length === 0) {
    return {
      ok: false,
      reason:
        `No installed ${agent} version is signed into account label '${label}' — ` +
        `explicit --account never falls back to another account. ` +
        `Sign in and verify: agents accounts attach ${label} ${agent}.`,
    };
  }

  const globalDefault = getGlobalDefault(agent);
  const picked =
    (globalDefault && matches.includes(globalDefault) ? globalDefault : null) ??
    [...matches].sort((a, b) => compareVersions(b, a))[0];

  return { ok: true, version: picked, fingerprint, matches: [picked, ...matches.filter((m) => m !== picked)] };
}
