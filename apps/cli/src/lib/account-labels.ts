import * as crypto from 'crypto';
import { getUserAgentsDir } from './state.js';
import { ACCOUNT_INSPECTION_AGENT_IDS } from './agents.js';
import type { AgentId } from './types.js';
import { collectRunCandidates, pickBalancedCandidate } from './rotate.js';
import { listInstalledVersions } from './versions.js';
import {
  accountRegistryPath,
  addManagedLoginAccount,
  findByLabel,
  readRegistry,
  removeAccount,
  renameAccount,
} from './account-registry.js';

// ── Public types (kept for backward compat with runner.ts, exec.ts, etc.) ──

export interface AccountLabel { agent: AgentId; fingerprint: string }
export interface AccountLabelsDocument { labels: Record<string, AccountLabel> }
export interface DiscoveredAccount { agent: AgentId; fingerprint: string; display: string; versions: string[]; label: string | null }

// ── Helpers ────────────────────────────────────────────────────────────────

export function identityFingerprint(agent: string, accountKey: string): string {
  return crypto.createHash('sha256').update(`${agent}\0${accountKey}`).digest('hex');
}

/** Same path as the account registry — both read/write accounts.yaml. */
export function accountLabelsPath(base = getUserAgentsDir()): string {
  return accountRegistryPath(base);
}

/**
 * Read all named accounts as the legacy label-map shape. Includes both
 * managed-login and api-key accounts so runner.ts existence checks work.
 * For api-key accounts, `fingerprint` is set to the account id (a UUID) —
 * runner.ts only uses it for existence, not auth matching.
 */
export function readAccountLabels(base = getUserAgentsDir()): AccountLabelsDocument {
  const doc = readRegistry(base);
  const labels: Record<string, AccountLabel> = {};
  for (const record of Object.values(doc.accounts)) {
    labels[record.label] = {
      agent: record.agent,
      fingerprint: record.credential.kind === 'managed-login'
        ? record.credential.fingerprint
        : record.id,
    };
  }
  return { labels };
}

/** Name a managed-login account. Delegates to the unified account registry. */
export function nameAccount(label: string, agent: AgentId, fingerprint: string, base = getUserAgentsDir()): void {
  addManagedLoginAccount(label, agent, fingerprint, base);
}

export function renameAccountLabel(oldLabel: string, newLabel: string, base = getUserAgentsDir()): void {
  renameAccount(oldLabel, newLabel, base);
}

export function removeAccountLabel(label: string, base = getUserAgentsDir()): void {
  removeAccount(label, base);
}

export function labelForFingerprint(agent: AgentId, fingerprint: string, doc = readAccountLabels()): string | null {
  return Object.entries(doc.labels).find(([, account]) => account.agent === agent && account.fingerprint === fingerprint)?.[0] ?? null;
}

export async function discoverAccounts(agentIds: readonly AgentId[] = ACCOUNT_INSPECTION_AGENT_IDS): Promise<DiscoveredAccount[]> {
  const labels = readAccountLabels(); const grouped = new Map<string, DiscoveredAccount>();
  await Promise.all(agentIds.map(async agent => {
    for (const candidate of await collectRunCandidates(agent)) {
      if (!candidate.signedIn || !candidate.accountKey) continue;
      const fingerprint = identityFingerprint(agent, candidate.accountKey); const key = `${agent}:${fingerprint}`; const existing = grouped.get(key);
      if (existing) existing.versions.push(candidate.version); else grouped.set(key, { agent, fingerprint, display: candidate.accountLabel || 'signed-in account', versions: [candidate.version], label: labelForFingerprint(agent, fingerprint, labels) });
    }
  }));
  return [...grouped.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.display.localeCompare(b.display));
}

export async function resolveAccountLabel(agent: AgentId, label: string): Promise<string> {
  const doc = readRegistry();
  const record = findByLabel(label, doc);
  if (!record) throw new Error(`Unknown account label '${label}'.`);
  if (record.agent !== agent) throw new Error(`Account label '${label}' names a ${record.agent} account, not ${agent}.`);

  // api-key accounts: any installed version works — key is injected at spawn time
  if (record.credential.kind === 'api-key') {
    const versions = listInstalledVersions(agent);
    if (!versions.length) throw new Error(`No installed ${agent} version found for account '${label}'.`);
    return versions[versions.length - 1];
  }

  // managed-login: match fingerprint against signed-in candidates
  const fingerprint = record.credential.fingerprint;
  const candidates = (await collectRunCandidates(agent)).filter(
    candidate => candidate.accountKey && identityFingerprint(agent, candidate.accountKey) === fingerprint,
  );
  const result = pickBalancedCandidate(candidates);
  if (!result) throw new Error(`No healthy installed ${agent} version is currently signed into account '${label}'.`);
  return result.picked.version;
}
