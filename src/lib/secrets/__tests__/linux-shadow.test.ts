/**
 * Linux read-through de-shadow + `import-keyring` behaviour. Mocks `spawnSync`
 * (secret-tool + `which`) so the tests are hermetic and run on any platform; the
 * file store underneath is real (temp dir + passphrase). Harness mirrors
 * windows.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawnSync: spawnSyncMock };
});

import {
  getSecretToolToken,
  setSecretToolToken,
  importNativeSecretToolItems,
  _resetForTest,
} from '../linux.js';

// ---- spawnSync dispatch harness ----
type Resp = { status: number; stdout?: string; stderr?: string; error?: Error };
// responder receives the secret-tool subcommand ('lookup'|'search'|'store'|…)
// and the full argv so it can pick out the item name.
let responder: (sub: string, args: string[]) => Resp;
let tmpDir: string;

beforeEach(() => {
  responder = () => { throw new Error('unexpected secret-tool call in this test'); };
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'which') return { status: 0, stdout: Buffer.from('/usr/bin/secret-tool'), stderr: Buffer.from('') };
    if (cmd === 'secret-tool') {
      const r = responder(args[0], args);
      return { status: r.status, stdout: Buffer.from(r.stdout ?? ''), stderr: Buffer.from(r.stderr ?? ''), error: r.error };
    }
    throw new Error(`unexpected spawn: ${cmd}`);
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-linux-shadow-'));
  process.env.AGENTS_SECRETS_PASSPHRASE = 'test-pass';
});

afterEach(() => {
  delete process.env.AGENTS_SECRETS_PASSPHRASE;
  _resetForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function itemOf(args: string[]): string {
  return args[args.indexOf('item') + 1];
}

describe('read-through under file fallback', () => {
  it('reads a keyring item that is not in the file store (no silent shadow)', () => {
    _resetForTest({ forceFileFallback: true, fileDir: tmpDir, passphrase: 'test-pass' });
    responder = (sub, args) => {
      if (sub === 'lookup') {
        return itemOf(args) === 'linear-api-key'
          ? { status: 0, stdout: 'lin_api_shadowed\n' }
          : { status: 1 };
      }
      throw new Error(`unexpected sub ${sub}`);
    };
    expect(getSecretToolToken('linear-api-key')).toBe('lin_api_shadowed');
  });

  it('throws not-found (never a false hit) when neither store has it', () => {
    _resetForTest({ forceFileFallback: true, fileDir: tmpDir, passphrase: 'test-pass' });
    responder = (sub) => (sub === 'lookup' ? { status: 1 } : (() => { throw new Error(sub); })());
    expect(() => getSecretToolToken('absent')).toThrow(/not found/i);
  });

  it('stops re-probing the keyring once it is seen locked', () => {
    _resetForTest({ forceFileFallback: true, fileDir: tmpDir, passphrase: 'test-pass' });
    let lookups = 0;
    responder = (sub) => {
      if (sub === 'lookup') { lookups += 1; return { status: 1, stderr: 'Cannot create an item in a locked collection' }; }
      throw new Error(sub);
    };
    expect(() => getSecretToolToken('a')).toThrow(/not found/i);
    expect(() => getSecretToolToken('b')).toThrow(/not found/i);
    // Second read short-circuits on the cached nativeUnreachable flag.
    expect(lookups).toBe(1);
  });
});

describe('importNativeSecretToolItems', () => {
  it('copies keyring items missing from the file store, skips existing ones (commit)', () => {
    _resetForTest({ forceFileFallback: true, fileDir: tmpDir, passphrase: 'test-pass' });
    setSecretToolToken('agents-cli.bundles.demo', 'already'); // seeds file store
    responder = (sub, args) => {
      if (sub === 'search') {
        return { status: 0, stderr: 'attribute.item = agents-cli.bundles.demo\nattribute.item = linear-api-key\n' };
      }
      if (sub === 'lookup') {
        return itemOf(args) === 'linear-api-key' ? { status: 0, stdout: 'lin_val\n' } : { status: 1 };
      }
      throw new Error(`unexpected sub ${sub}`);
    };
    const report = importNativeSecretToolItems('', true);
    expect(report.available).toBe(true);
    expect(report.locked).toBe(false);
    const byItem = Object.fromEntries(report.results.map((r) => [r.item, r.status]));
    expect(byItem['agents-cli.bundles.demo']).toBe('exists');
    expect(byItem['linear-api-key']).toBe('imported');
    // Imported value now round-trips from the file store.
    expect(getSecretToolToken('linear-api-key')).toBe('lin_val');
  });

  it('reports would-import without writing on a dry run', () => {
    _resetForTest({ forceFileFallback: true, fileDir: tmpDir, passphrase: 'test-pass' });
    responder = (sub, args) => {
      if (sub === 'search') return { status: 0, stderr: 'attribute.item = linear-team-id\n' };
      if (sub === 'lookup') return itemOf(args) === 'linear-team-id' ? { status: 0, stdout: 'team_123\n' } : { status: 1 };
      throw new Error(sub);
    };
    const report = importNativeSecretToolItems('', false);
    expect(report.results).toEqual([{ item: 'linear-team-id', status: 'would-import' }]);
    // Not written: a later get must not find it in the file store.
    responder = (sub) => (sub === 'lookup' ? { status: 1 } : (() => { throw new Error(sub); })());
    expect(() => getSecretToolToken('linear-team-id')).toThrow(/not found/i);
  });

  it('reports locked (nothing read) when the collection is locked', () => {
    _resetForTest({ forceFileFallback: true, fileDir: tmpDir, passphrase: 'test-pass' });
    responder = (sub) => (sub === 'search' ? { status: 1, stderr: 'locked collection' } : (() => { throw new Error(sub); })());
    const report = importNativeSecretToolItems('', true);
    expect(report.locked).toBe(true);
    expect(report.results).toEqual([]);
  });
});
