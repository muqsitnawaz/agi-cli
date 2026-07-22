import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeychainBackend } from '../secrets/index.js';

class MemBackend implements KeychainBackend {
  store = new Map<string, string>();

  has(item: string): boolean {
    return this.store.has(item);
  }

  get(item: string): string {
    const value = this.store.get(item);
    if (value === undefined) throw new Error(`missing ${item}`);
    return value;
  }

  getBatch(items: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const item of items) {
      const value = this.store.get(item);
      if (value !== undefined) out.set(item, value);
    }
    return out;
  }

  set(item: string, value: string): void {
    this.store.set(item, value);
  }

  delete(item: string): boolean {
    return this.store.delete(item);
  }

  list(prefix: string): string[] {
    return [...this.store.keys()].filter((item) => item.startsWith(prefix));
  }
}

let originalHome: string | undefined;
let home: string;
let restoreBackend: KeychainBackend | null = null;

async function loadShareConfig() {
  const secrets = await import('../secrets/index.js');
  const mem = new MemBackend();
  restoreBackend = secrets.setKeychainBackendForTest(mem);
  return {
    ...(await import('./config.js')),
    ...(await import('../secrets/bundles.js')),
    ...(await import('../state.js')),
    secrets,
    mem,
  };
}

describe('share config wiring', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-config-'));
    process.env.HOME = home;
    vi.resetModules();
    restoreBackend = null;
  });

  afterEach(async () => {
    const secrets = await import('../secrets/index.js');
    secrets.setKeychainBackendForTest(restoreBackend);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it('persists the endpoint in Meta.share and trims baseUrl on read', async () => {
    const { writeShareConfig, readShareConfig, readMeta } = await loadShareConfig();

    writeShareConfig({
      baseUrl: 'https://share.example.com///',
      accountId: 'acct-123',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });

    expect(readMeta().share).toEqual({
      baseUrl: 'https://share.example.com///',
      accountId: 'acct-123',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });
    expect(readShareConfig()).toEqual({
      baseUrl: 'https://share.example.com',
      accountId: 'acct-123',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });
  });

  it('stores and reads the write token from the share secrets bundle', async () => {
    const {
      SHARE_BUNDLE,
      SHARE_TOKEN_KEY,
      readBundle,
      readWriteToken,
      secrets,
      storeWriteToken,
    } = await loadShareConfig();

    storeWriteToken('token-123');

    const bundle = readBundle(SHARE_BUNDLE);
    expect(bundle.vars[SHARE_TOKEN_KEY]).toBe(`keychain:${SHARE_TOKEN_KEY}`);
    expect(readWriteToken()).toBe('token-123');
    expect(secrets.secretsKeychainItem(SHARE_BUNDLE, SHARE_TOKEN_KEY)).toBe(
      'agents-cli.secrets.share.SHARE_WRITE_TOKEN',
    );
  });

  it('returns null until all required Meta.share fields are present', async () => {
    const { readShareConfig, updateMeta } = await loadShareConfig();

    updateMeta((meta) => ({ ...meta, share: { baseUrl: 'https://share.example.com' } }));

    expect(readShareConfig()).toBeNull();
  });
});
