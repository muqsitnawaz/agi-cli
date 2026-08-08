import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type KeychainBackend,
  secretsKeychainItem,
  setKeychainBackendForTest,
  setKeychainToken,
} from './secrets/index.js';
import {
  addApiKeyAccount,
  addManagedLoginAccount,
  findByLabel,
  readRegistry,
  removeAccount,
  renameAccount,
  resolveAccountForExec,
  setAccountKey,
} from './account-registry.js';

class MemBackend implements KeychainBackend {
  store = new Map<string, string>();
  has(item: string) { return this.store.has(item); }
  get(item: string) {
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`missing keychain item: ${item}`);
    return v;
  }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter(k => k.startsWith(prefix)); }
}

describe('account registry', () => {
  let root = '';
  let mem: MemBackend;
  let prevBackend: KeychainBackend | null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-registry-'));
    mem = new MemBackend();
    prevBackend = setKeychainBackendForTest(mem);
  });
  afterEach(() => {
    setKeychainBackendForTest(prevBackend);
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('managed-login accounts', () => {
    it('stores without raw fingerprint data in YAML', () => {
      const fingerprint = 'abc123fingerprint';
      addManagedLoginAccount('work', 'claude', fingerprint, root);
      const raw = fs.readFileSync(path.join(root, 'accounts.yaml'), 'utf8');
      expect(raw).toContain('version: 2');
      expect(raw).toContain('managed-login');
      expect(raw).toContain(fingerprint); // fingerprint is not a secret
    });

    it('prevents a label from naming two different accounts', () => {
      addManagedLoginAccount('work', 'claude', 'fp1', root);
      expect(() => addManagedLoginAccount('work', 'codex', 'fp2', root)).toThrow('already names another account');
    });

    it('prevents one managed-login account from having two labels', () => {
      addManagedLoginAccount('work', 'claude', 'fp1', root);
      expect(() => addManagedLoginAccount('personal', 'claude', 'fp1', root)).toThrow("already named 'work'");
    });

    it('is idempotent for the same agent+fingerprint', () => {
      const r1 = addManagedLoginAccount('work', 'claude', 'fp1', root);
      const r2 = addManagedLoginAccount('work', 'claude', 'fp1', root);
      expect(r1.id).toBe(r2.id);
    });
  });

  describe('api-key accounts', () => {
    it('stores key in keychain, not YAML', () => {
      addApiKeyAccount('myaccount', 'cursor', 'sk-secret-key', root);
      const raw = fs.readFileSync(path.join(root, 'accounts.yaml'), 'utf8');
      expect(raw).not.toContain('sk-secret-key');
      expect(raw).toContain('api-key');
      expect(raw).toContain('keychain:');
    });

    it('stores key in keychain under stable account id namespace', () => {
      const record = addApiKeyAccount('myaccount', 'cursor', 'sk-test', root);
      const keychainItem = secretsKeychainItem(record.id, 'API_KEY');
      expect(mem.store.get(keychainItem)).toBe('sk-test');
    });

    it('prevents duplicate labels', () => {
      addApiKeyAccount('work', 'cursor', 'sk-1', root);
      expect(() => addApiKeyAccount('work', 'cursor', 'sk-2', root)).toThrow("already exists");
    });

    it('rejects an empty key', () => {
      expect(() => addApiKeyAccount('work', 'cursor', '', root)).toThrow('cannot be empty');
    });

    it('rejects an unsupported agent', () => {
      expect(() => addApiKeyAccount('work', 'claude' as 'cursor', 'sk-1', root)).toThrow('No API-key provider adapter');
    });
  });

  describe('setAccountKey', () => {
    it('updates the keychain entry, YAML unchanged', () => {
      const record = addApiKeyAccount('work', 'cursor', 'sk-old', root);
      const keychainItem = secretsKeychainItem(record.id, 'API_KEY');
      setAccountKey('work', 'sk-new', root);
      expect(mem.store.get(keychainItem)).toBe('sk-new');
      const doc = readRegistry(root);
      const updated = findByLabel('work', doc)!;
      expect(updated.credential.kind).toBe('api-key');
      // secretRef points to same stable item
      if (updated.credential.kind === 'api-key') {
        expect(updated.credential.secretRef.value).toBe(keychainItem);
      }
    });

    it('throws for managed-login accounts', () => {
      addManagedLoginAccount('work', 'claude', 'fp1', root);
      expect(() => setAccountKey('work', 'sk-1', root)).toThrow('managed-login');
    });

    it('throws for unknown label', () => {
      expect(() => setAccountKey('nobody', 'sk-1', root)).toThrow("Unknown account label 'nobody'");
    });
  });

  describe('removeAccount', () => {
    it('removes api-key account and cleans up keychain', () => {
      const record = addApiKeyAccount('work', 'cursor', 'sk-1', root);
      const keychainItem = secretsKeychainItem(record.id, 'API_KEY');
      expect(mem.store.has(keychainItem)).toBe(true);
      removeAccount('work', root);
      expect(mem.store.has(keychainItem)).toBe(false);
      expect(findByLabel('work', readRegistry(root))).toBeNull();
    });

    it('removes managed-login account without touching keychain', () => {
      addManagedLoginAccount('work', 'claude', 'fp1', root);
      const storeSize = mem.store.size;
      removeAccount('work', root);
      expect(mem.store.size).toBe(storeSize); // no keychain change
      expect(findByLabel('work', readRegistry(root))).toBeNull();
    });

    it('throws for unknown label', () => {
      expect(() => removeAccount('nobody', root)).toThrow("Unknown account label 'nobody'");
    });
  });

  describe('renameAccount', () => {
    it('renames without changing the id', () => {
      const record = addManagedLoginAccount('work', 'claude', 'fp1', root);
      renameAccount('work', 'company', root);
      const doc = readRegistry(root);
      expect(findByLabel('work', doc)).toBeNull();
      const renamed = findByLabel('company', doc)!;
      expect(renamed.id).toBe(record.id);
    });

    it('throws when new label already exists', () => {
      addManagedLoginAccount('work', 'claude', 'fp1', root);
      addManagedLoginAccount('personal', 'codex', 'fp2', root);
      expect(() => renameAccount('work', 'personal', root)).toThrow("already exists");
    });

    it('rejects invalid label format', () => {
      addManagedLoginAccount('work', 'claude', 'fp1', root);
      expect(() => renameAccount('work', '-bad', root)).toThrow('Label must start');
    });
  });

  describe('migration from v1', () => {
    it('migrates label-only accounts.yaml transparently', () => {
      const v1 = `labels:\n  work:\n    agent: claude\n    fingerprint: abc123\n  personal:\n    agent: codex\n    fingerprint: def456\n`;
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'accounts.yaml'), v1, 'utf8');
      const doc = readRegistry(root);
      expect(doc.version).toBe(2);
      expect(Object.keys(doc.accounts)).toHaveLength(2);
      const work = findByLabel('work', doc)!;
      expect(work.agent).toBe('claude');
      expect(work.credential.kind).toBe('managed-login');
      if (work.credential.kind === 'managed-login') expect(work.credential.fingerprint).toBe('abc123');
      // Written back as v2
      const raw = fs.readFileSync(path.join(root, 'accounts.yaml'), 'utf8');
      expect(raw).toContain('version: 2');
    });

    it('preserves stable ids across reads after migration', () => {
      const v1 = `labels:\n  work:\n    agent: claude\n    fingerprint: abc123\n`;
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'accounts.yaml'), v1, 'utf8');
      const doc1 = readRegistry(root);
      const doc2 = readRegistry(root);
      expect(findByLabel('work', doc1)!.id).toBe(findByLabel('work', doc2)!.id);
    });
  });

  describe('resolveAccountForExec', () => {
    it('returns injection env for api-key account', () => {
      addApiKeyAccount('work', 'cursor', 'sk-realkey', root);
      const resolved = resolveAccountForExec('work', root);
      expect(resolved.credentialKind).toBe('api-key');
      expect(resolved.injectionEnv['CURSOR_API_KEY']).toBe('sk-realkey');
      expect(resolved.agent).toBe('cursor');
    });

    it('does not expose secret bytes in non-env fields', () => {
      addApiKeyAccount('work', 'cursor', 'sk-secret', root);
      const resolved = resolveAccountForExec('work', root);
      const nonEnv = JSON.stringify({ ...resolved, injectionEnv: undefined });
      expect(nonEnv).not.toContain('sk-secret');
    });

    it('returns empty injectionEnv for managed-login accounts', () => {
      addManagedLoginAccount('work', 'claude', 'fp1', root);
      const resolved = resolveAccountForExec('work', root);
      expect(resolved.credentialKind).toBe('managed-login');
      expect(Object.keys(resolved.injectionEnv)).toHaveLength(0);
    });

    it('throws for unknown label', () => {
      expect(() => resolveAccountForExec('nobody', root)).toThrow("Unknown account label 'nobody'");
    });
  });

  describe('from-secrets import', () => {
    it('copies a key from an existing bundle keychain item into the account', () => {
      // Seed the "source" bundle entry as if `agents secrets add cursor-api API_KEY sk-fromBundle` ran
      setKeychainToken(secretsKeychainItem('cursor-api', 'API_KEY'), 'sk-from-bundle');
      const sourceKey = mem.store.get(secretsKeychainItem('cursor-api', 'API_KEY'))!;
      addApiKeyAccount('work', 'cursor', sourceKey, root);
      const resolved = resolveAccountForExec('work', root);
      expect(resolved.injectionEnv['CURSOR_API_KEY']).toBe('sk-from-bundle');
    });
  });
});
