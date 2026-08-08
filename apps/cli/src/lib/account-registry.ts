import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';
import type { AgentId } from './types.js';
import {
  type SecretRef,
  parseBundleValue,
  serializeRef,
  secretsKeychainItem,
  getKeychainToken,
  setKeychainToken,
  deleteKeychainToken,
} from './secrets/index.js';
import { getProviderAdapter } from './account-provider-registry.js';

// ── Types ──────────────────────────────────────────────────────────────

export type ManagedLoginCredential = { kind: 'managed-login'; fingerprint: string };
export type ApiKeyCredential = { kind: 'api-key'; secretRef: SecretRef };
export type AccountCredential = ManagedLoginCredential | ApiKeyCredential;

export interface AccountRecord {
  /** Stable UUID, never changes. Namespaces the keychain item for api-key accounts. */
  id: string;
  /** User-visible name. */
  label: string;
  agent: AgentId;
  credential: AccountCredential;
}

export interface AccountRegistryDocument {
  version: 2;
  accounts: Record<string, AccountRecord>; // keyed by id
}

export interface ResolvedAccount {
  accountId: string;
  accountLabel: string;
  agent: AgentId;
  credentialKind: 'managed-login' | 'api-key';
  /**
   * Env vars to inject at spawn time. Secret bytes are fetched from the
   * device-local keychain here; they are never stored in YAML or returned
   * to display callers.
   */
  injectionEnv: Record<string, string>;
}

// ── Paths ──────────────────────────────────────────────────────────────

export function accountRegistryPath(base = getUserAgentsDir()): string {
  return path.join(base, 'accounts.yaml');
}

// ── Serialization ──────────────────────────────────────────────────────

function serializeCredential(cred: AccountCredential): unknown {
  if (cred.kind === 'managed-login') return { kind: 'managed-login', fingerprint: cred.fingerprint };
  return { kind: 'api-key', secretRef: serializeRef(cred.secretRef) };
}

function deserializeCredential(raw: unknown): AccountCredential {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid credential in account registry');
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'managed-login') {
    if (typeof obj.fingerprint !== 'string') throw new Error('managed-login credential missing fingerprint');
    return { kind: 'managed-login', fingerprint: obj.fingerprint };
  }
  if (obj.kind === 'api-key') {
    if (typeof obj.secretRef !== 'string') throw new Error('api-key credential missing secretRef string');
    const parsed = parseBundleValue(obj.secretRef);
    if (!('ref' in parsed)) throw new Error(`api-key secretRef must be a provider:value string, got: ${obj.secretRef}`);
    return { kind: 'api-key', secretRef: parsed.ref };
  }
  throw new Error(`Unknown credential kind: ${String(obj.kind)}`);
}

// ── I/O ───────────────────────────────────────────────────────────────

function emptyRegistry(): AccountRegistryDocument {
  return { version: 2, accounts: {} };
}

/**
 * Read the account registry. Transparently migrates a v1 label-only
 * accounts.yaml to v2 format on first read, writing the result back.
 */
export function readRegistry(base = getUserAgentsDir()): AccountRegistryDocument {
  const file = accountRegistryPath(base);
  if (!fs.existsSync(file)) return emptyRegistry();
  const raw = yaml.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Account registry corrupted at ${file}: expected a YAML map`);
  }
  const doc = raw as Record<string, unknown>;
  // Detect v1 (label-only) format: has `labels` key, no `version`
  if (!doc.version && doc.labels !== undefined) {
    return migrateFromV1(
      (doc.labels ?? {}) as Record<string, { agent: string; fingerprint: string }>,
      base,
    );
  }
  if (doc.version !== 2) throw new Error(`Unknown account registry version: ${doc.version}`);
  const accounts: Record<string, AccountRecord> = {};
  for (const [id, entry] of Object.entries((doc.accounts ?? {}) as Record<string, unknown>)) {
    const e = entry as Record<string, unknown>;
    accounts[id] = {
      id: typeof e.id === 'string' ? e.id : id,
      label: String(e.label ?? ''),
      agent: String(e.agent ?? '') as AgentId,
      credential: deserializeCredential(e.credential),
    };
  }
  return { version: 2, accounts };
}

export function writeRegistry(doc: AccountRegistryDocument, base = getUserAgentsDir()): void {
  const file = accountRegistryPath(base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serializable: Record<string, unknown> = {};
  for (const [id, record] of Object.entries(doc.accounts)) {
    serializable[id] = {
      id: record.id,
      label: record.label,
      agent: record.agent,
      credential: serializeCredential(record.credential),
    };
  }
  atomicWriteFileSync(file, yaml.stringify({ version: 2, accounts: serializable }));
}

// ── Migration ─────────────────────────────────────────────────────────

function migrateFromV1(
  labels: Record<string, { agent: string; fingerprint: string }>,
  base = getUserAgentsDir(),
): AccountRegistryDocument {
  const accounts: Record<string, AccountRecord> = {};
  for (const [label, entry] of Object.entries(labels)) {
    const id = crypto.randomUUID();
    accounts[id] = {
      id,
      label,
      agent: entry.agent as AgentId,
      credential: { kind: 'managed-login', fingerprint: entry.fingerprint },
    };
  }
  const doc: AccountRegistryDocument = { version: 2, accounts };
  writeRegistry(doc, base);
  return doc;
}

// ── Label helpers ─────────────────────────────────────────────────────

export function assertLabel(label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(label)) {
    throw new Error(
      'Label must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.',
    );
  }
}

export function findByLabel(label: string, doc: AccountRegistryDocument): AccountRecord | null {
  return Object.values(doc.accounts).find(r => r.label === label) ?? null;
}

export function findById(id: string, doc: AccountRegistryDocument): AccountRecord | null {
  return doc.accounts[id] ?? null;
}

// ── CRUD ──────────────────────────────────────────────────────────────

/** Add a managed-login account. Used internally by `accounts name`. */
export function addManagedLoginAccount(
  label: string,
  agent: AgentId,
  fingerprint: string,
  base = getUserAgentsDir(),
): AccountRecord {
  assertLabel(label);
  const doc = readRegistry(base);
  const existing = findByLabel(label, doc);
  if (existing) {
    // Idempotent: same agent+fingerprint → no-op
    if (
      existing.agent === agent &&
      existing.credential.kind === 'managed-login' &&
      existing.credential.fingerprint === fingerprint
    ) return existing;
    throw new Error(`Account label '${label}' already names another account.`);
  }
  // One managed-login account may not have two labels
  const duplicate = Object.values(doc.accounts).find(
    r => r.agent === agent && r.credential.kind === 'managed-login' && r.credential.fingerprint === fingerprint,
  );
  if (duplicate) throw new Error(`This ${agent} account is already named '${duplicate.label}'.`);
  const id = crypto.randomUUID();
  const record: AccountRecord = { id, label, agent, credential: { kind: 'managed-login', fingerprint } };
  doc.accounts[id] = record;
  writeRegistry(doc, base);
  return record;
}

/**
 * Add an api-key account. Stores the key in the device-local keychain under
 * a namespace derived from the stable account id — raw bytes never enter YAML.
 */
export function addApiKeyAccount(
  label: string,
  agent: AgentId,
  key: string,
  base = getUserAgentsDir(),
): AccountRecord {
  assertLabel(label);
  getProviderAdapter(agent).validateKey(key);
  const doc = readRegistry(base);
  if (findByLabel(label, doc)) throw new Error(`Account label '${label}' already exists.`);
  const id = crypto.randomUUID();
  // noAcl: key must be readable headlessly without biometric prompt
  setKeychainToken(secretsKeychainItem(id, 'API_KEY'), key, { noAcl: true });
  const record: AccountRecord = {
    id,
    label,
    agent,
    credential: { kind: 'api-key', secretRef: { provider: 'keychain', value: secretsKeychainItem(id, 'API_KEY') } },
  };
  doc.accounts[id] = record;
  writeRegistry(doc, base);
  return record;
}

/** Update the API key for an existing api-key account. */
export function setAccountKey(label: string, key: string, base = getUserAgentsDir()): void {
  const doc = readRegistry(base);
  const record = findByLabel(label, doc);
  if (!record) throw new Error(`Unknown account label '${label}'.`);
  if (record.credential.kind !== 'api-key') {
    throw new Error(`Account '${label}' is a managed-login account; only api-key accounts support set-key.`);
  }
  getProviderAdapter(record.agent).validateKey(key);
  // secretRef already points to secretsKeychainItem(record.id, 'API_KEY') — YAML unchanged
  setKeychainToken(secretsKeychainItem(record.id, 'API_KEY'), key, { noAcl: true });
}

/** Remove an account. Cleans up the keychain entry for api-key accounts. */
export function removeAccount(label: string, base = getUserAgentsDir()): void {
  const doc = readRegistry(base);
  const record = findByLabel(label, doc);
  if (!record) throw new Error(`Unknown account label '${label}'.`);
  if (record.credential.kind === 'api-key') {
    deleteKeychainToken(secretsKeychainItem(record.id, 'API_KEY'));
  }
  delete doc.accounts[record.id];
  writeRegistry(doc, base);
}

/** Rename an account label. */
export function renameAccount(oldLabel: string, newLabel: string, base = getUserAgentsDir()): void {
  assertLabel(newLabel);
  const doc = readRegistry(base);
  const record = findByLabel(oldLabel, doc);
  if (!record) throw new Error(`Unknown account label '${oldLabel}'.`);
  if (findByLabel(newLabel, doc)) throw new Error(`Account label '${newLabel}' already exists.`);
  record.label = newLabel;
  writeRegistry(doc, base);
}

// ── Resolver API ──────────────────────────────────────────────────────

/**
 * Resolve a named account for exec-time use. Reads the device-local keychain
 * secret (for api-key accounts) and returns injection metadata. Never called
 * on the display path — only from the exec/spawn path that will inject the env.
 */
export function resolveAccountForExec(label: string, base = getUserAgentsDir()): ResolvedAccount {
  const doc = readRegistry(base);
  const record = findByLabel(label, doc);
  if (!record) throw new Error(`Unknown account label '${label}'.`);
  const injectionEnv: Record<string, string> = {};
  if (record.credential.kind === 'api-key') {
    const adapter = getProviderAdapter(record.agent);
    injectionEnv[adapter.keyEnvVar] = getKeychainToken(secretsKeychainItem(record.id, 'API_KEY'));
  }
  return {
    accountId: record.id,
    accountLabel: record.label,
    agent: record.agent,
    credentialKind: record.credential.kind,
    injectionEnv,
  };
}
