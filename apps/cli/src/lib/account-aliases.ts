/**
 * Durable aliases for harness-native logins (RUSH-2527).
 *
 * A provider account ([[account-registry]]) owns a long-lived credential the
 * CLI stores. A native login is different: the harness owns its own OAuth/
 * session, and agents-cli only ever *reads* which identity is signed in. An
 * alias is the one durable thing we add on top — a stable local name for that
 * native identity, so `agents view claude` and the account list can show `work`
 * instead of a bare email, and so the name survives version churn.
 *
 * The record is metadata only: a stable generated id, the local name, the
 * harness, and an identity fingerprint. It never stores tokens, OAuth
 * payloads, or the raw email — the fingerprint is `sha256(agent\0identity)`,
 * the same scheme the retired native-label store used, so archived labels
 * re-bind to a live login without change. The raw `identity` (an account key
 * or lowercased email) is kept only when an alias is created from a live login,
 * purely to render a friendlier row; a recovered legacy label has only the
 * fingerprint and still matches by it.
 *
 * The store is a small YAML file under the agents dir, keyed by base like
 * [[account-registry]], so it is fully unit-testable against a temp home and
 * never touches `meta`. The provider-account vs alias name namespace is unified
 * by the command layer ([[accounts]]), which checks both stores before it names
 * anything; this module deliberately does not import the registry so the two
 * stay acyclic.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';
import { ACCOUNT_NAME_RE, assertAccountName } from './account-schema.js';
import type { AgentId } from './types.js';

/** One durable alias for a harness-native login identity. */
export interface NativeAlias {
  /** Stable generated id; survives rename. */
  id: string;
  /** Unique local display name. */
  name: string;
  /** The harness whose native login this names. */
  agent: AgentId;
  /** Identity match key: `sha256(agent\0identity)`. Always present. */
  fingerprint: string;
  /** Raw native identity (account key or lowercased email) when known. */
  identity?: string;
}

export interface NativeAliasesDocument {
  version: 1;
  aliases: Record<string, NativeAlias>;
}

export function nativeAliasesPath(base = getUserAgentsDir()): string {
  return path.join(base, 'account-aliases.yaml');
}

/**
 * The identity match key. Same construction the retired native-label store
 * used, so an archived label's fingerprint re-binds to a live login here.
 */
export function identityFingerprint(agent: string, identity: string): string {
  return crypto.createHash('sha256').update(`${agent}\0${identity}`).digest('hex');
}

/** Read the alias store, folding any archived legacy labels in first. */
export function readNativeAliases(base = getUserAgentsDir()): NativeAliasesDocument {
  migrateArchivedLabels(base);
  return readNativeAliasesRaw(base);
}

/** Read the alias store without triggering legacy migration (avoids recursion). */
function readNativeAliasesRaw(base: string): NativeAliasesDocument {
  const file = nativeAliasesPath(base);
  if (!fs.existsSync(file)) return { version: 1, aliases: {} };
  const raw = yaml.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw || Array.isArray(raw)) throw new Error(`Alias store corrupted at ${file}: expected a YAML map.`);
  if (raw.version !== 1) throw new Error(`Unsupported alias store version '${String(raw.version)}' at ${file}.`);
  const aliases: Record<string, NativeAlias> = {};
  const entries = (raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases))
    ? raw.aliases as Record<string, Record<string, unknown>>
    : {};
  for (const [id, value] of Object.entries(entries)) {
    const alias = parseAlias(id, value);
    if (alias) aliases[alias.id] = alias;
  }
  return { version: 1, aliases };
}

function parseAlias(id: string, value: Record<string, unknown>): NativeAlias | null {
  const name = typeof value.name === 'string' ? value.name : '';
  const agent = typeof value.agent === 'string' ? value.agent as AgentId : undefined;
  const fingerprint = typeof value.fingerprint === 'string' ? value.fingerprint : '';
  if (!name || !agent || !fingerprint) return null;
  const identity = typeof value.identity === 'string' ? value.identity : undefined;
  return { id: String(value.id ?? id), name, agent, fingerprint, identity };
}

function writeNativeAliases(doc: NativeAliasesDocument, base: string): void {
  atomicWriteFileSync(nativeAliasesPath(base), yaml.stringify(doc));
}

export function findAliasByName(name: string, doc: NativeAliasesDocument): NativeAlias | null {
  return doc.aliases[name] ?? Object.values(doc.aliases).find(alias => alias.name === name) ?? null;
}

/** The alias that names a given live login, matched by fingerprint. */
export function findAliasForLogin(agent: AgentId, identity: string, doc: NativeAliasesDocument): NativeAlias | null {
  const fingerprint = identityFingerprint(agent, identity);
  return Object.values(doc.aliases).find(alias => alias.agent === agent && alias.fingerprint === fingerprint) ?? null;
}

export interface SetNativeAliasInput {
  name: string;
  agent: AgentId;
  identity: string;
}

/**
 * Name a live native login. The name must be unique across aliases; a second
 * `name` for the same identity moves the name to it rather than duplicating.
 * Returns the stored record. Callers enforce the provider-account namespace.
 */
export function setNativeAlias(input: SetNativeAliasInput, base = getUserAgentsDir()): NativeAlias {
  assertAccountName(input.name);
  const doc = readNativeAliases(base);
  const byName = findAliasByName(input.name, doc);
  const fingerprint = identityFingerprint(input.agent, input.identity);
  const existingForIdentity = Object.values(doc.aliases).find(alias => alias.agent === input.agent && alias.fingerprint === fingerprint);
  if (byName && byName.id !== existingForIdentity?.id) {
    throw new Error(`Account name '${input.name}' is already used by a ${byName.agent} alias. Choose a different name.`);
  }
  const id = existingForIdentity?.id ?? crypto.randomUUID();
  // Drop any stale name this identity previously carried before re-keying it.
  if (existingForIdentity) delete doc.aliases[existingForIdentity.id];
  const record: NativeAlias = { id, name: input.name, agent: input.agent, fingerprint, identity: input.identity };
  doc.aliases[id] = record;
  writeNativeAliases(doc, base);
  return record;
}

export function renameNativeAlias(oldName: string, newName: string, base = getUserAgentsDir()): NativeAlias {
  assertAccountName(newName);
  const doc = readNativeAliases(base);
  const alias = findAliasByName(oldName, doc);
  if (!alias) throw new Error(`Unknown account alias '${oldName}'.`);
  if (findAliasByName(newName, doc)) throw new Error(`Account name '${newName}' already exists.`);
  const renamed: NativeAlias = { ...alias, name: newName };
  doc.aliases[alias.id] = renamed;
  writeNativeAliases(doc, base);
  return renamed;
}

export function removeNativeAlias(name: string, base = getUserAgentsDir()): NativeAlias {
  const doc = readNativeAliases(base);
  const alias = findAliasByName(name, doc);
  if (!alias) throw new Error(`Unknown account alias '${name}'.`);
  delete doc.aliases[alias.id];
  writeNativeAliases(doc, base);
  return alias;
}

/**
 * Fold retired native labels (`{ labels: { name: { agent, fingerprint } } }`)
 * into aliases. Pure over the parsed label map; the caller owns archiving the
 * source file. Skips a label whose name already exists as an alias so an
 * interrupted or repeated run never duplicates or throws. Returns how many
 * new aliases landed.
 */
export function foldLegacyLabels(labels: Record<string, unknown>, base = getUserAgentsDir()): number {
  const doc = readNativeAliasesRaw(base);
  let added = 0;
  for (const [name, value] of Object.entries(labels)) {
    if (!value || typeof value !== 'object') continue;
    const label = value as Record<string, unknown>;
    const agent = typeof label.agent === 'string' ? label.agent as AgentId : undefined;
    const fingerprint = typeof label.fingerprint === 'string' ? label.fingerprint : undefined;
    if (!agent || !fingerprint || !ACCOUNT_NAME_RE.test(name)) continue;
    if (findAliasByName(name, doc)) continue;
    if (Object.values(doc.aliases).some(alias => alias.agent === agent && alias.fingerprint === fingerprint)) continue;
    const id = crypto.randomUUID();
    doc.aliases[id] = { id, name, agent, fingerprint };
    added += 1;
  }
  if (added) writeNativeAliases(doc, base);
  return added;
}

/**
 * Recover labels an older CLI archived to `accounts.legacy-labels.yaml` before
 * this alias store existed. Folds them in and renames the archive to
 * `.migrated` so it runs once. Idempotent.
 */
export function migrateArchivedLabels(base: string): void {
  const archived = path.join(base, 'accounts.legacy-labels.yaml');
  if (!fs.existsSync(archived)) return;
  const raw = yaml.parse(fs.readFileSync(archived, 'utf8')) as Record<string, unknown> | null;
  const labels = (raw?.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels))
    ? raw.labels as Record<string, unknown>
    : {};
  foldLegacyLabels(labels, base);
  const target = path.join(base, 'accounts.legacy-labels.migrated.yaml');
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  fs.renameSync(archived, target);
}
