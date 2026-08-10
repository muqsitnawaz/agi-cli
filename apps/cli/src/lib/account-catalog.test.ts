import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setKeychainBackendForTest, type KeychainBackend } from './secrets/index.js';
import { addAccount } from './account-registry.js';
import { listAccountCatalog } from './account-catalog.js';

class MemoryKeychain implements KeychainBackend {
  values = new Map<string, string>();
  has(item: string) { return this.values.has(item); }
  get(item: string) { const value = this.values.get(item); if (value === undefined) throw new Error('missing'); return value; }
  set(item: string, value: string) { this.values.set(item, value); }
  delete(item: string) { return this.values.delete(item); }
  list(prefix: string) { return [...this.values.keys()].filter(item => item.startsWith(prefix)); }
}

describe('unified account discovery', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-catalog-')); setKeychainBackendForTest(new MemoryKeychain()); });
  afterEach(() => { setKeychainBackendForTest(null); fs.rmSync(root, { recursive: true, force: true }); });

  it('lists bundle-backed credential accounts', () => {
    addAccount('work', 'openrouter', 'api-key', 'sk', root);
    const catalog = listAccountCatalog({ base: root });
    expect(catalog).toEqual([
      { source: 'bundle', name: 'work', provider: 'openrouter', auth: 'api-key', id: expect.any(String), secretPresent: true },
    ]);
  });

  it('folds native OAuth logins in alongside bundle accounts without converting them', () => {
    addAccount('work', 'cursor', 'api-key', 'sk', root);
    const catalog = listAccountCatalog({
      base: root,
      nativeAccounts: [{ agent: 'claude', provider: 'anthropic', display: 'me@example.com' }],
    });
    expect(catalog.map(a => [a.source, a.name])).toEqual([
      ['oauth-native', 'me@example.com'],
      ['bundle', 'work'],
    ]);
    const native = catalog.find(a => a.source === 'oauth-native')!;
    expect(native).toMatchObject({ agent: 'claude', provider: 'anthropic', secretPresent: true });
    expect(native.id).toBeUndefined(); // native stays native — no bundle id minted
  });

  it('accepts a lazy native source', () => {
    let called = false;
    listAccountCatalog({ base: root, nativeAccounts: () => { called = true; return []; } });
    expect(called).toBe(true);
  });
});
