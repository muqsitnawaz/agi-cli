import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordSecretUsage,
  getBundleUsage,
  getAllBundleUsage,
  closeSecretsUsageDb,
} from './usage-db.js';

// Isolate every test to its own temp secrets.db via the AGENTS_SECRETS_DB escape
// hatch (getSecretsDbPath reads it at call time), and make sure recording is ON
// (a prior suite may have set AGENTS_NO_USAGE_TRACK).
let dir: string;
let prevNoTrack: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-usage-'));
  process.env.AGENTS_SECRETS_DB = path.join(dir, 'secrets.db');
  prevNoTrack = process.env.AGENTS_NO_USAGE_TRACK;
  delete process.env.AGENTS_NO_USAGE_TRACK;
  closeSecretsUsageDb();
});

afterEach(() => {
  closeSecretsUsageDb();
  delete process.env.AGENTS_SECRETS_DB;
  if (prevNoTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoTrack;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recordSecretUsage + getBundleUsage', () => {
  it('creates the db on first write and aggregates per-event counts', () => {
    recordSecretUsage({ bundle: 'stripe.com', event: 'access', keyCount: 3 });
    recordSecretUsage({ bundle: 'stripe.com', event: 'access', keyCount: 3 });
    recordSecretUsage({ bundle: 'stripe.com', event: 'export', source: 'shell' });
    recordSecretUsage({ bundle: 'stripe.com', event: 'unlock' });

    expect(fs.existsSync(process.env.AGENTS_SECRETS_DB!)).toBe(true);

    const u = getBundleUsage('stripe.com');
    expect(u).toBeTruthy();
    expect(u!.total).toBe(4);
    expect(u!.events.access.count).toBe(2);
    expect(u!.events.export.count).toBe(1);
    expect(u!.events.unlock.count).toBe(1);
    expect(u!.events.import.count).toBe(0);
    // Every recorded event carries a timestamp; the zero-count kind has none.
    expect(u!.events.access.last).toBeTruthy();
    expect(u!.events.import.last).toBeNull();
    expect(u!.lastUsedAt).toBeTruthy();
    expect(u!.firstUsedAt).toBeTruthy();
  });

  it('returns undefined for a bundle with no recorded usage', () => {
    recordSecretUsage({ bundle: 'other', event: 'access' });
    expect(getBundleUsage('never-touched')).toBeUndefined();
  });

  it('ignores an empty bundle name (usage is per-bundle by definition)', () => {
    recordSecretUsage({ bundle: '', event: 'access' });
    expect(getAllBundleUsage().size).toBe(0);
  });

  it('honors AGENTS_NO_USAGE_TRACK by not writing anything', () => {
    process.env.AGENTS_NO_USAGE_TRACK = '1';
    recordSecretUsage({ bundle: 'stripe.com', event: 'access' });
    expect(getBundleUsage('stripe.com')).toBeUndefined();
  });
});

describe('getAllBundleUsage', () => {
  it('summarizes every bundle that has any event, keyed by name', () => {
    recordSecretUsage({ bundle: 'a.com', event: 'access' });
    recordSecretUsage({ bundle: 'a.com', event: 'access' });
    recordSecretUsage({ bundle: 'b.app', event: 'import' });

    const all = getAllBundleUsage();
    expect(all.size).toBe(2);
    expect(all.get('a.com')!.events.access.count).toBe(2);
    expect(all.get('b.app')!.events.import.count).toBe(1);
    expect(all.get('b.app')!.events.access.count).toBe(0);
  });

  it('empty map when nothing has been recorded', () => {
    expect(getAllBundleUsage().size).toBe(0);
  });
});

describe('path isolation', () => {
  it('reopens against a fresh AGENTS_SECRETS_DB path (no stale handle reuse)', () => {
    recordSecretUsage({ bundle: 'first', event: 'access' });
    expect(getBundleUsage('first')).toBeTruthy();

    // Point at a brand-new db file; the module must reopen, not reuse the old
    // handle — otherwise a test's writes would bleed into the previous file.
    const second = path.join(dir, 'second.db');
    process.env.AGENTS_SECRETS_DB = second;
    expect(getBundleUsage('first')).toBeUndefined();
    recordSecretUsage({ bundle: 'second', event: 'access' });
    expect(fs.existsSync(second)).toBe(true);
    expect(getBundleUsage('second')).toBeTruthy();
  });
});
