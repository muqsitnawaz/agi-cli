/**
 * Discovery of harness-native logins, and their fold with durable aliases.
 *
 * A native login is a signed-in harness identity read live from each installed
 * version home — agents-cli never copies its auth bytes. The durable name a
 * person can give one lives in [[account-aliases]] (a metadata-only store keyed
 * by an identity fingerprint); this module discovers the live logins and stitches
 * the matching alias name onto each. Credential accounts are the sibling concept,
 * owned by [[account-registry]]; the one account namespace across both is enforced
 * by `assertAccountName` in [[account-schema]].
 */
import { ALL_AGENT_IDS, getAccountInfo, supportsAccountInspection } from './agents.js';
import { getVersionHomePath, listInstalledVersions } from './versions.js';
import { getUserAgentsDir } from './state.js';
import { findAliasForLogin, readNativeAliases, type NativeAliasesDocument } from './account-aliases.js';
import type { AgentId } from './types.js';

export interface NativeAccountCatalogEntry {
  kind: 'native';
  id: string;
  agent: AgentId;
  display: string;
  email: string | null;
  versions: string[];
  /** Durable alias name for this identity, when one has been assigned. */
  alias?: string;
  /** Stable id of the assigned alias. */
  aliasId?: string;
}

export function groupNativeAccountRows(rows: Array<{ agent: AgentId; version: string; accountKey: string | null; email: string | null; signedIn: boolean }>): NativeAccountCatalogEntry[] {
  const grouped = new Map<string, NativeAccountCatalogEntry>();
  for (const row of rows) {
    if (!row.signedIn) continue;
    const identity = row.accountKey ?? row.email?.toLowerCase();
    if (!identity) continue;
    const key = `${row.agent}:${identity}`;
    const existing = grouped.get(key);
    if (existing) existing.versions.push(row.version);
    else grouped.set(key, {
      kind: 'native',
      id: identity,
      agent: row.agent,
      display: row.email ?? identity,
      email: row.email,
      versions: [row.version],
    });
  }
  return [...grouped.values()].map(entry => ({ ...entry, versions: [...new Set(entry.versions)].sort() }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.display.localeCompare(b.display));
}

/**
 * Stitch durable aliases onto discovered native identities by matching harness +
 * identity fingerprint. Pure so the merge is unit-testable without a live login.
 */
export function applyNativeAliases(entries: NativeAccountCatalogEntry[], aliases: NativeAliasesDocument): NativeAccountCatalogEntry[] {
  return entries.map(entry => {
    const alias = findAliasForLogin(entry.agent, entry.id, aliases);
    return alias ? { ...entry, alias: alias.name, aliasId: alias.id } : entry;
  });
}

/** Discover signed-in harness-native identities without copying their auth files. */
export async function discoverNativeAccounts(base = getUserAgentsDir()): Promise<NativeAccountCatalogEntry[]> {
  const rows: Array<{ agent: AgentId; version: string; accountKey: string | null; email: string | null; signedIn: boolean }> = [];
  for (const agent of ALL_AGENT_IDS.filter(supportsAccountInspection)) {
    for (const version of listInstalledVersions(agent)) {
      const info = await getAccountInfo(agent, getVersionHomePath(agent, version));
      rows.push({ agent, version, accountKey: info.accountKey, email: info.email, signedIn: info.signedIn });
    }
  }
  return applyNativeAliases(groupNativeAccountRows(rows), readNativeAliases(base));
}
