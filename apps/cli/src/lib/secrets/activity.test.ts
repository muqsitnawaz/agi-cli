/**
 * Tests for the secrets activity DB (~/.agents/secrets/secrets.db).
 *
 * Both layers on the real path, mirroring audit.test.ts:
 *  1. `recordSecretActivity` writes metadata-only events to a real SQLite DB in
 *     a temp dir, maintains the use_count / last_used_at aggregates (access
 *     events only), and honors the AGENTS_NO_USAGE_TRACK kill-switch.
 *  2. The real read chokepoint (`readAndResolveBundleEnv`, file backend with
 *     real AES-GCM crypto) records an `access` event — the event that powers
 *     `agents secrets list --sort freq` and the view activity section.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../sqlite.js';
import {
  recordSecretActivity,
  getBundleUsage,
  listBundleUsage,
  getRecentBundleEvents,
  secretsActivityDbPath,
  _resetSecretsActivityForTest,
} from './activity.js';
import {
  bundleItemStore,
  keychainRef,
  readAndResolveBundleEnv,
  writeBundle,
  type SecretsBundle,
} from './bundles.js';
import { _resetFileStoreForTest } from './filestore.js';
import { secretsKeychainItem, setKeychainBackendForTest, type KeychainBackend } from './index.js';

const tmpDirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secret-activity-'));
  tmpDirs.push(d);
  return d;
}

/** Point the activity DB at a temp path and re-open it fresh. */
function setupDb(): string {
  const dbPath = path.join(tempDir(), 'secrets.db');
  _resetSecretsActivityForTest(dbPath);
  return dbPath;
}

let prevNoUsage: string | undefined;
beforeEach(() => {
  // tests/setup.ts sets the kill-switch globally; these tests exercise the
  // tracking itself, so lift it (restored in afterEach).
  prevNoUsage = process.env.AGENTS_NO_USAGE_TRACK;
  delete process.env.AGENTS_NO_USAGE_TRACK;
});

afterEach(() => {
  if (prevNoUsage === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoUsage;
  _resetSecretsActivityForTest();
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs.length = 0;
});

describe('recordSecretActivity', () => {
  it('records metadata-only events and bumps use_count on access only', () => {
    setupDb();
    recordSecretActivity({ bundle: 'anthropic.com', kind: 'create', source: 'create' });
    recordSecretActivity({ bundle: 'anthropic.com', kind: 'import', detail: '--from .env', source: 'import' });
    recordSecretActivity({ bundle: 'anthropic.com', kind: 'access' });
    recordSecretActivity({ bundle: 'anthropic.com', kind: 'access' });
    recordSecretActivity({ bundle: 'anthropic.com', kind: 'view', source: 'view' });

    const usage = getBundleUsage('anthropic.com');
    expect(usage).not.toBeNull();
    expect(usage!.useCount).toBe(2); // access events only — views don't inflate freq
    expect(usage!.lastUsedAt).not.toBeNull();

    const events = getRecentBundleEvents('anthropic.com', 10);
    expect(events.map((e) => e.kind)).toEqual(['view', 'access', 'access', 'import', 'create']);
    // Metadata only — no event may carry a secret value.
    for (const e of events) {
      expect(e).not.toHaveProperty('value');
      expect(JSON.stringify(e)).not.toContain('sk-');
    }
  });

  it('getRecentBundleEvents is newest-first and honors the limit', () => {
    setupDb();
    for (let i = 0; i < 8; i++) {
      recordSecretActivity({ bundle: 'b', kind: 'view', detail: `view #${i}` });
    }
    const events = getRecentBundleEvents('b', 5);
    expect(events).toHaveLength(5);
    expect(events[0].detail).toBe('view #7');
    expect(events[4].detail).toBe('view #3');
  });

  it('listBundleUsage returns aggregates for every recorded bundle', () => {
    setupDb();
    recordSecretActivity({ bundle: 'a.com', kind: 'access' });
    recordSecretActivity({ bundle: 'a.com', kind: 'access' });
    recordSecretActivity({ bundle: 'b.app', kind: 'access' });
    recordSecretActivity({ bundle: 'c.ai', kind: 'create' }); // no access — no row

    const usage = listBundleUsage();
    expect(usage.get('a.com')?.useCount).toBe(2);
    expect(usage.get('b.app')?.useCount).toBe(1);
    expect(usage.has('c.ai')).toBe(false);
  });

  it('honors the AGENTS_NO_USAGE_TRACK kill-switch', () => {
    setupDb();
    process.env.AGENTS_NO_USAGE_TRACK = '1';
    recordSecretActivity({ bundle: 'prod', kind: 'access' });
    expect(getBundleUsage('prod')).toBeNull();
    expect(getRecentBundleEvents('prod')).toEqual([]);
  });

  it('prunes events older than the retention window on open', () => {
    const dbPath = setupDb();
    recordSecretActivity({ bundle: 'prod', kind: 'view', detail: 'recent' });
    _resetSecretsActivityForTest();
    // Backdate one event beyond the 90d retention window directly in SQLite,
    // then re-open — the open path prunes it.
    const db = new Database(dbPath);
    db.prepare(`UPDATE events SET ts = ? WHERE detail = 'recent'`).run(
      new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
    );
    db.close();
    _resetSecretsActivityForTest(dbPath);
    recordSecretActivity({ bundle: 'prod', kind: 'view', detail: 'fresh' });
    const events = getRecentBundleEvents('prod', 10);
    expect(events.map((e) => e.detail)).toEqual(['fresh']);
  });

  it('uses AGENTS_SECRETS_DB_PATH when set', () => {
    const dbPath = path.join(tempDir(), 'custom.db');
    process.env.AGENTS_SECRETS_DB_PATH = dbPath;
    try {
      _resetSecretsActivityForTest();
      expect(secretsActivityDbPath()).toBe(dbPath);
    } finally {
      delete process.env.AGENTS_SECRETS_DB_PATH;
    }
  });
});

describe('secret access activity — real read path (file backend)', () => {
  let restore: KeychainBackend | null = null;
  const PASS = 'activity-test-passphrase';

  beforeEach(() => {
    setupDb();
    const store = new Map<string, { value: string }>();
    const backend: KeychainBackend = {
      has: (i) => store.has(i),
      get: (i) => { const v = store.get(i); if (!v) throw new Error(`missing ${i}`); return v.value; },
      set: (i, v) => { store.set(i, { value: v }); },
      delete: (i) => store.delete(i),
      list: (p) => [...store.keys()].filter((k) => k.startsWith(p)),
    };
    restore = setKeychainBackendForTest(backend);
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    _resetFileStoreForTest({ fileDir: tempDir(), passphrase: PASS });
  });

  afterEach(() => {
    setKeychainBackendForTest(restore);
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetFileStoreForTest();
  });

  it('readAndResolveBundleEnv records an access event and bumps use_count', () => {
    const bundle: SecretsBundle = { name: 'rel', backend: 'file', vars: {} };
    bundleItemStore('file').set(secretsKeychainItem('rel', 'TOKEN'), 'sealed-value');
    bundle.vars['TOKEN'] = keychainRef('TOKEN');
    writeBundle(bundle);

    const { env } = readAndResolveBundleEnv('rel', { caller: 'command deploy', agent: 'claude' });
    expect(env.TOKEN).toBe('sealed-value'); // real decrypt happened

    const usage = getBundleUsage('rel');
    expect(usage?.useCount).toBe(1);
    const events = getRecentBundleEvents('rel', 5);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('access');
    // The decrypted value never enters the activity record.
    expect(JSON.stringify(events)).not.toContain('sealed-value');
  });
});
