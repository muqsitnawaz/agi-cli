/**
 * Tests for the passphrase policy of the shared encrypted-file store.
 *
 * The crypto round-trip and basic file-store ops are covered by
 * __tests__/linux.test.ts (which exercises the same module via the Linux
 * backend re-exports). This file pins the NEW `allowAutoProvision` seam that
 * the macOS file-backed bundle path relies on: with auto-provision OFF, a
 * missing passphrase is a hard error and NO machine-local key is written to
 * disk — so a remote/headless Mac can only decrypt with a passphrase handed in
 * per run, never one sitting next to the ciphertext.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock only spawnSync (the win32 TTY prompt path); keep execSync real so the
// POSIX TTY branch and crypto still work. Same pattern as windows.test.ts:9-13.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawnSync: spawnSyncMock };
});

import { execSync } from 'child_process';
import {
  fileStore, getPassphrase, disableTtyEchoOrThrow, _resetFileStoreForTest,
  rotatePassphrase, machinePassphraseSourcePath, encryptForFallback, decryptForFallback,
  _setFileStoreLockTimeoutForTest,
  type EncFile,
} from './filestore.js';

describe('disableTtyEchoOrThrow (RUSH-1764: fail closed so a passphrase never echoes)', () => {
  it('throws (fail closed) when echo cannot be disabled — never falls through', () => {
    // A real command that exits non-zero stands in for "stty unavailable".
    expect(() => disableTtyEchoOrThrow(() => { execSync('exit 7', { stdio: 'ignore' }); }))
      .toThrow(/cleartext|echo could not be disabled/i);
  });

  it('does not throw when echo is disabled successfully', () => {
    // A real no-op command succeeds; the guard passes through.
    expect(() => disableTtyEchoOrThrow(() => { execSync('true', { stdio: 'ignore' }); })).not.toThrow();
  });
});

describe('filestore passphrase policy (allowAutoProvision)', () => {
  let tmpRoot: string;
  let storeDir: string;
  let keyDir: string;
  let prevTty: boolean | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-filestore-'));
    storeDir = path.join(tmpRoot, 'store');
    keyDir = path.join(tmpRoot, 'key');
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    // Force the headless branch deterministically regardless of how the runner
    // was launched (a real TTY would otherwise hit the interactive prompt).
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('with allowAutoProvision:false and no passphrase, getPassphrase throws (no passphrase written)', () => {
    expect(() => getPassphrase({ allowAutoProvision: false })).toThrow(/AGENTS_SECRETS_PASSPHRASE/);
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, '.passphrase'))).toBe(false);
  });

  it('with allowAutoProvision:false, fileStore.set refuses and writes nothing to disk', () => {
    expect(() => fileStore.set('agents-cli.secrets.b.K', 'v', { allowAutoProvision: false }))
      .toThrow(/AGENTS_SECRETS_PASSPHRASE/);
    // No ciphertext, no provisioned key — the box holds nothing decryptable.
    const storeEntries = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : [];
    expect(storeEntries.filter((e) => e.endsWith('.enc'))).toEqual([]);
    expect(storeEntries).not.toContain('.passphrase');
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(false);
  });

  it('with an explicit AGENTS_SECRETS_PASSPHRASE, set/get round-trips with auto-provision OFF', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'per-run-key';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    const opts = { allowAutoProvision: false } as const;
    fileStore.set('agents-cli.secrets.b.K', 'sealed', opts);
    expect(fileStore.get('agents-cli.secrets.b.K', opts)).toBe('sealed');
    // Encrypted on disk; the machine key was never provisioned.
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir, '.passphrase'))).toBe(false);
    const enc = fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.b.K.enc'), 'utf8');
    expect(enc).not.toContain('sealed');
  });

  it('with the wrong passphrase, get fails the auth tag with a clear message (auto-provision OFF)', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'right';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.b.K', 'sealed', { allowAutoProvision: false });
    process.env.AGENTS_SECRETS_PASSPHRASE = 'wrong';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => fileStore.get('agents-cli.secrets.b.K', { allowAutoProvision: false }))
      .toThrow(/decrypt|passphrase/i);
  });

  it('auto-provisions the passphrase outside the encrypted store dir (#479)', () => {
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    const storeEntries = fs.readdirSync(storeDir);
    expect(storeEntries).toContain('agents-cli.secrets.b.K.enc');
    expect(storeEntries).not.toContain('.passphrase');
    expect(storeEntries).not.toContain('passphrase');
    expect(fs.existsSync(path.join(keyDir, 'passphrase'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(keyDir, 'passphrase')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(keyDir).mode & 0o777).toBe(0o700);
    }
  });
});

// Windows has no /dev/tty; the interactive prompt must route through PowerShell
// Read-Host instead of crashing with a raw ENOENT on fs.openSync('/dev/tty').
describe('filestore win32 interactive passphrase branch', () => {
  let tmpRoot: string;
  let storeDir: string;
  let keyDir: string;
  let prevTty: boolean | undefined;
  let prevPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-filestore-win-'));
    storeDir = path.join(tmpRoot, 'store');
    keyDir = path.join(tmpRoot, 'key');
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    // Interactive (isTTY) + win32 so getPassphrase reaches the TTY prompt.
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnSyncMock.mockReset();
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    if (prevPlatform) Object.defineProperty(process, 'platform', prevPlatform);
    spawnSyncMock.mockReset();
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads the passphrase via PowerShell Read-Host, not /dev/tty', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe('powershell.exe');
      expect(args).toContain('-EncodedCommand');
      // -NonInteractive would suppress Read-Host, so it must be absent.
      expect(args).not.toContain('-NonInteractive');
      return { status: 0, stdout: Buffer.from('typed-pass\r\n'), stderr: Buffer.from('') };
    });
    // Round-trips a value using the prompted passphrase (proves it flows through).
    fileStore.set('agents-cli.secrets.b.K', 'sealed');
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    spawnSyncMock.mockImplementation(() => ({
      status: 0, stdout: Buffer.from('typed-pass\n'), stderr: Buffer.from(''),
    }));
    expect(fileStore.get('agents-cli.secrets.b.K')).toBe('sealed');
  });

  it('throws an actionable error (not ENOENT) when PowerShell cannot run', () => {
    spawnSyncMock.mockImplementation(() => ({
      status: 1, stdout: Buffer.from(''), stderr: Buffer.from(''), error: new Error('spawn ENOENT'),
    }));
    expect(() => getPassphrase()).toThrow(/AGENTS_SECRETS_PASSPHRASE/);
  });
});

// RUSH-1975: rotate the file store's machine-local master passphrase. The
// catastrophic failure this guards is a half-re-keyed store (every secret lost),
// so these pin the atomic contract: verify before swap, a crash leaves the old
// store readable, a bad round-trip aborts, and dry-run writes nothing.
describe('rotatePassphrase (RUSH-1975)', () => {
  let tmpRoot: string;
  let storeDir: string;
  let keyDir: string;
  let keyFile: string;
  const OLD_KEY = 'old-machine-key-value';
  let prevTty: boolean | undefined;

  /** Seed a keychain-named item into the file store under the current key. */
  function seed(bundle: string, key: string, value: string): string {
    const item = `agents-cli.secrets.${bundle}.${key}`;
    fileStore.set(item, value);
    return `${item}.enc`;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-rotate-'));
    storeDir = path.join(tmpRoot, 'store');
    keyDir = path.join(tmpRoot, 'key');
    keyFile = path.join(keyDir, 'passphrase');
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    // Provision a known machine-local key so the store is encrypted under a value
    // the test controls (rather than an auto-generated one).
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, OLD_KEY, { mode: 0o600 });
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('happy path: re-encrypts every item under a new key and rewrites the 0600 key file', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    seed('daily', 'C', 'value-c');

    const rep = rotatePassphrase({ newPassphrase: 'brand-new-key' });
    expect(rep.committed).toBe(true);
    expect(rep.dryRun).toBe(false);
    expect(rep.bundleCount).toBe(3);
    expect(rep.roundTripOk).toBe(true);
    expect(rep.skipped).toEqual([]);

    // Key file rewritten in place with the new value, still 0600.
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('brand-new-key');
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    }

    // Every item now decrypts under the NEW key and NOT the old one.
    for (const [item, want] of [
      ['agents-cli.secrets.prod.A', 'value-a'],
      ['agents-cli.secrets.prod.B', 'value-b'],
      ['agents-cli.secrets.daily.C', 'value-c'],
    ] as const) {
      const enc = JSON.parse(fs.readFileSync(path.join(storeDir, `${item}.enc`), 'utf8')) as EncFile;
      expect(decryptForFallback(enc, 'brand-new-key')).toBe(want);
      expect(() => decryptForFallback(enc, OLD_KEY)).toThrow();
    }
    // The live resolver reads the rotated values transparently.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');

    // No staging/backup dirs or key temp files left behind.
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fs.readdirSync(keyDir)).toEqual(['passphrase']);
  });

  it('dry-run reports the count and round-trip but writes nothing', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeStore = fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')]);
    const beforeKey = fs.readFileSync(keyFile, 'utf8');

    const rep = rotatePassphrase({ dryRun: true, newPassphrase: 'unused' });
    expect(rep.dryRun).toBe(true);
    expect(rep.committed).toBe(false);
    expect(rep.bundleCount).toBe(2);
    expect(rep.roundTripOk).toBe(true);

    // Byte-for-byte unchanged: no ciphertext rewritten, key file untouched.
    expect(fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')])).toEqual(beforeStore);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(beforeKey);
  });

  it('a crash mid-run (after staging, before the swap) leaves the old store readable under the old key', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeStore = fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')]);

    expect(() => rotatePassphrase({
      newPassphrase: 'never-lands',
      onStagedBeforeCommit: () => { throw new Error('simulated crash'); },
    })).toThrow(/simulated crash/);

    // The live store and key file are exactly as they were — old key still works.
    expect(fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')])).toEqual(beforeStore);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(OLD_KEY);
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    const enc = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(() => decryptForFallback(enc, 'never-lands')).toThrow();

    // A subsequent rotation recovers past the abandoned staging dir and succeeds.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir, passphrase: OLD_KEY });
    const rep = rotatePassphrase({ newPassphrase: 'clean-key' });
    expect(rep.committed).toBe(true);
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
  });

  it('Window A: crash after the store swap, before the key swap — next run recovers a readable store instead of sweeping the artifacts', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in Window A: the NEW-key store is live, the OLD key file is still in
    // place, and both recovery artifacts (`.rotate-new` = new key, `.rotate-old-*`
    // = old store) are on disk. The presence-based recovery would see store+key
    // both present and sweep both artifacts, orphaning every secret permanently.
    expect(() => rotatePassphrase({
      newPassphrase: 'winA-key',
      onStoreSwappedBeforeKeySwap: () => { throw new Error('crash in Window A'); },
    })).toThrow(/Window A/);

    // Prove the dangerous on-disk state the crash left: store is NEW-key, key file
    // is still OLD (a mismatch), and neither artifact has been swept.
    const encCrash = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encCrash, 'winA-key')).toBe('value-a');
    expect(() => decryptForFallback(encCrash, OLD_KEY)).toThrow();
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(OLD_KEY);
    expect(fs.existsSync(`${keyFile}.rotate-new`)).toBe(true);
    expect(fs.readdirSync(tmpRoot).some((e) => e.startsWith('store.rotate-old-'))).toBe(true);

    // Next run recovers. Under the old presence-based code this second rotation
    // would abort ("No item decrypted under the current machine-local key") with
    // every secret unreadable; content-aware recovery installs the new key first.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    const rep = rotatePassphrase({ newPassphrase: 'winA-final' });
    expect(rep.committed).toBe(true);

    // Store and key are paired again (no mismatch), every value survived, and the
    // artifacts are gone only now that a forward decrypt was proven.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('winA-final');
    const encAfter = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encAfter, 'winA-final')).toBe('value-a');
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fs.readdirSync(keyDir).sort()).toEqual(['passphrase']);
  });

  it('Window B: crash after the old key is moved aside, before the new key lands — next run recovers forward, not onto the wrong key', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in Window B: the NEW-key store is live, the key file is ABSENT (moved to
    // `.rotate-oldkey`), and `.rotate-new` holds the new key. The presence-based code
    // restores the OLD key from `.rotate-oldkey` onto the NEW store (wrong key), then
    // sweeps `.rotate-new` + the old-store backup, orphaning every secret.
    expect(() => rotatePassphrase({
      newPassphrase: 'winB-key',
      onKeyBackedUpBeforeNewKey: () => { throw new Error('crash in Window B'); },
    })).toThrow(/Window B/);

    // Prove the on-disk state the crash left.
    const encCrash = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encCrash, 'winB-key')).toBe('value-a');
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(fs.readFileSync(`${keyFile}.rotate-oldkey`, 'utf8')).toBe(OLD_KEY);
    expect(fs.readFileSync(`${keyFile}.rotate-new`, 'utf8')).toBe('winB-key');
    expect(fs.readdirSync(tmpRoot).some((e) => e.startsWith('store.rotate-old-'))).toBe(true);

    // Next run must finish the rotation forward — install the NEW key from
    // `.rotate-new` — not restore the OLD key onto the NEW store.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    const rep = rotatePassphrase({ newPassphrase: 'winB-final' });
    expect(rep.committed).toBe(true);

    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('winB-final');
    const encAfter = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encAfter, 'winB-final')).toBe('value-a');
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fs.readdirSync(keyDir).sort()).toEqual(['passphrase']);
  });

  it('aborts (writing nothing) when a re-encrypted item fails to round-trip under the new key', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeStore = fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')]);

    expect(() => rotatePassphrase({ newPassphrase: 'nk', tamperStaged: true }))
      .toThrow(/verify|round-trip/i);

    // Verify-before-swap: nothing was written, key file untouched.
    expect(fs.readdirSync(storeDir).sort().map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')])).toEqual(beforeStore);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(OLD_KEY);
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
  });

  it('re-keys valid items and copies through an orphan encrypted under a different key', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    // An orphan: valid EncFile JSON, but sealed under a key the store does not use.
    const orphanEnc = encryptForFallback('orphan-secret', 'some-other-key');
    const orphanName = 'agents-cli.secrets.orphan.X.enc';
    fs.writeFileSync(path.join(storeDir, orphanName), JSON.stringify(orphanEnc), { mode: 0o600});
    const orphanBefore = fs.readFileSync(path.join(storeDir, orphanName), 'utf8');

    const rep = rotatePassphrase({ newPassphrase: 'nk' });
    expect(rep.committed).toBe(true);
    expect(rep.bundleCount).toBe(2);
    expect(rep.skipped.length).toBe(1);
    expect(rep.skipped[0]).toContain('orphan.X');

    // The orphan is carried through byte-identical (never re-keyed, never dropped).
    expect(fs.readFileSync(path.join(storeDir, orphanName), 'utf8')).toBe(orphanBefore);
    // The real items are re-keyed.
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'nk')).toBe('value-a');
  });

  it('MIXED store (Window A crash + an interstitial write) is REFUSED, not swept — no silent loss', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in Window A: the NEW-key store is live, the OLD key file is still in
    // place, `.rotate-new` (= new key) and the old-store backup are on disk.
    expect(() => rotatePassphrase({
      newPassphrase: 'winA-newkey',
      onStoreSwappedBeforeKeySwap: () => { throw new Error('crash in Window A'); },
    })).toThrow(/Window A/);

    // An ordinary `secrets set` now seals ONE item under the stale on-disk (OLD)
    // key, INTO the already-NEW-key store dir. The store is now MIXED: A and B under
    // the new key, C under the old key. This is exactly the reviewer's repro.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.prod.C', 'value-c', { allowAutoProvision: true });

    // The next rotate must NOT read "one item opens under the live key" as
    // "consistent, sweep". It must detect the mixed store and refuse, preserving
    // BOTH the only copy of the new key (`.rotate-new`) and the old-ciphertext
    // backup — nothing reports success, no secret is destroyed.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => rotatePassphrase({ newPassphrase: 'winA-again' })).toThrow(/MIXED/i);

    // Every recovery artifact survived.
    expect(fs.readFileSync(`${keyFile}.rotate-new`, 'utf8')).toBe('winA-newkey');
    expect(fs.readdirSync(tmpRoot).some((e) => e.startsWith('store.rotate-old-'))).toBe(true);

    // And every pre-rotation secret is still recoverable off disk: A and B under the
    // preserved new key, C under the live old key. Under the old "any item opens"
    // sweep, A and B were unreadable under every key left on disk.
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    const encB = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.B.enc'), 'utf8')) as EncFile;
    const encC = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.C.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'winA-newkey')).toBe('value-a');
    expect(decryptForFallback(encB, 'winA-newkey')).toBe('value-b');
    expect(decryptForFallback(encC, OLD_KEY)).toBe('value-c');
  });

  it('MIXED store (Window B crash + an interstitial write under a fresh key) is REFUSED, not swept', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');

    // Crash in Window B: the NEW-key store is live, the key file is ABSENT (moved to
    // `.rotate-oldkey`), `.rotate-new` holds the new key.
    expect(() => rotatePassphrase({
      newPassphrase: 'winB-newkey',
      onKeyBackedUpBeforeNewKey: () => { throw new Error('crash in Window B'); },
    })).toThrow(/Window B/);
    expect(fs.existsSync(keyFile)).toBe(false);

    // With the key file gone, an ordinary `secrets set` auto-provisions a THIRD key
    // and seals C under it — while A and B are still under the new key. Mixed store.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set('agents-cli.secrets.prod.C', 'value-c', { allowAutoProvision: true });
    const thirdKey = fs.readFileSync(keyFile, 'utf8'); // the freshly provisioned key

    // Recovery must refuse the mixed store rather than sweep the new key.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(() => rotatePassphrase({ newPassphrase: 'winB-again' })).toThrow(/MIXED/i);

    expect(fs.readFileSync(`${keyFile}.rotate-new`, 'utf8')).toBe('winB-newkey');
    expect(fs.readFileSync(`${keyFile}.rotate-oldkey`, 'utf8')).toBe(OLD_KEY);
    expect(fs.readdirSync(tmpRoot).some((e) => e.startsWith('store.rotate-old-'))).toBe(true);

    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    const encC = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.C.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'winB-newkey')).toBe('value-a');
    expect(decryptForFallback(encC, thirdKey)).toBe('value-c');
  });

  it('a store where no item opens under any candidate key is left intact (no sweep)', () => {
    // Seed a store that decrypts under NO key on disk: one .enc sealed under a key
    // that is neither the live key nor any rotation artifact.
    const strayEnc = encryptForFallback('stray-secret', 'a-key-nobody-has');
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(storeDir, 'agents-cli.secrets.gone.X.enc'), JSON.stringify(strayEnc), { mode: 0o600 });
    // A dangling `.rotate-new` artifact (under yet another key) makes recovery run,
    // but there is no backup dir, so neither forward nor rollback is provable.
    fs.writeFileSync(`${keyFile}.rotate-new`, 'another-unrelated-key', { mode: 0o600 });
    const encBefore = fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.gone.X.enc'), 'utf8');

    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    // The rotation itself has nothing it can decrypt, so it aborts — but recovery
    // must NOT have swept the artifacts on the way in.
    expect(() => rotatePassphrase({ newPassphrase: 'nk' })).toThrow(/No item decrypted/i);

    expect(fs.existsSync(`${keyFile}.rotate-new`)).toBe(true);
    expect(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.gone.X.enc'), 'utf8')).toBe(encBefore);
  });

  it('the store lock serializes a concurrent write and a second rotation against a rotation in progress', () => {
    seed('prod', 'A', 'value-a');
    _setFileStoreLockTimeoutForTest(150); // fail fast instead of the 30s budget

    let setError: unknown;
    let rotError: unknown;
    // The rotation holds the store lock for its whole run. Fire a competing write
    // and a competing rotation from inside the mid-swap window: both must find the
    // lock held and fail to acquire (rather than interleave into a mixed store).
    const rep = rotatePassphrase({
      newPassphrase: 'nk',
      onStoreSwappedBeforeKeySwap: () => {
        try { fileStore.set('agents-cli.secrets.prod.C', 'racer', { allowAutoProvision: true }); }
        catch (e) { setError = e; }
        try { rotatePassphrase({ newPassphrase: 'nk2' }); }
        catch (e) { rotError = e; }
      },
    });

    expect(rep.committed).toBe(true); // the holder finished; the challengers were blocked
    expect((setError as Error)?.message).toMatch(/Could not acquire lock/);
    expect((rotError as Error)?.message).toMatch(/Could not acquire lock/);
    // The blocked write never landed — no stray item forged a mixed store.
    expect(fs.existsSync(path.join(storeDir, 'agents-cli.secrets.prod.C.enc'))).toBe(false);

    // With the lock free, a write and a rotation both succeed normally.
    fileStore.set('agents-cli.secrets.prod.C', 'value-c', { allowAutoProvision: true });
    expect(fileStore.get('agents-cli.secrets.prod.C')).toBe('value-c');
    const rep2 = rotatePassphrase({ newPassphrase: 'nk3' });
    expect(rep2.committed).toBe(true);
  });

  it('throws when there is no machine-local passphrase to rotate', () => {
    seed('prod', 'A', 'value-a');
    fs.rmSync(keyFile);
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(machinePassphraseSourcePath()).toBeNull();
    expect(() => rotatePassphrase()).toThrow(/machine-local passphrase/i);
  });
});

/**
 * Co-located legacy key layout (pre-#479): the machine-local key lives INSIDE the
 * store dir as `.passphrase`, so `keyColocated` is true and the swap is a single
 * directory rename that carries both ciphertext and key. Every fixture in the
 * block above puts the key in a separate `keyDir`, so that path had zero coverage.
 */
describe('rotatePassphrase — co-located legacy key layout (RUSH-1975)', () => {
  let tmpRoot: string;
  let storeDir: string;
  let emptyKeyDir: string;
  let keyFile: string; // storeDir/.passphrase — the co-located legacy key
  const OLD_KEY = 'old-colocated-key-value';
  let prevTty: boolean | undefined;

  function seed(bundle: string, key: string, value: string): string {
    const item = `agents-cli.secrets.${bundle}.${key}`;
    fileStore.set(item, value);
    return `${item}.enc`;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-rotate-colo-'));
    storeDir = path.join(tmpRoot, 'store');
    emptyKeyDir = path.join(tmpRoot, 'key'); // canonical passphrase dir, kept empty
    keyFile = path.join(storeDir, '.passphrase');
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    // Provision the key at the legacy co-located path (inside the store dir) and
    // point the canonical passphrase dir at an empty dir, so the source resolves the
    // key to storeDir/.passphrase and `dirname(keyPath) === fileDir()` (colocated).
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(emptyKeyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, OLD_KEY, { mode: 0o600 });
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: emptyKeyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevTty, configurable: true });
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('re-keys through a single directory rename and rewrites the co-located key in place', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    // Prove the fixture actually exercises the colocated path (dirname === storeDir).
    expect(machinePassphraseSourcePath()).toBe(keyFile);
    expect(path.dirname(keyFile)).toBe(storeDir);

    const rep = rotatePassphrase({ newPassphrase: 'colo-new' });
    expect(rep.committed).toBe(true);
    expect(rep.bundleCount).toBe(2);
    expect(rep.roundTripOk).toBe(true);

    // The key file INSIDE the swapped store dir now holds the NEW passphrase, 0600.
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('colo-new');
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    }
    // Values still resolve after the rotation, under the new key and not the old.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'colo-new')).toBe('value-a');
    expect(() => decryptForFallback(encA, OLD_KEY)).toThrow();

    // No stray rotate artifacts, and the key stayed co-located (never leaked to keyDir).
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    expect(fs.readdirSync(emptyKeyDir)).toEqual([]);
  });

  it('crash in the single-rename window (store dir absent) recovers to the old store+key, then a retry rotates cleanly', () => {
    seed('prod', 'A', 'value-a');
    seed('prod', 'B', 'value-b');
    const beforeStore = fs.readdirSync(storeDir).sort()
      .map((f) => [f, fs.readFileSync(path.join(storeDir, f), 'utf8')]);

    // Crash after the live store is moved aside but before the staged store lands —
    // the store dir is absent, the old store+key sit in `store.rotate-old-*`, the new
    // store+key sit in the staging dir. This is the ONLY crash window for a colocated
    // key: one rename carries both, so there is no NEW-store/OLD-key mismatch to leave.
    expect(() => rotatePassphrase({
      newPassphrase: 'colo-crash',
      onStoreMovedAsideBeforeSwap: () => { throw new Error('crash in single-rename window'); },
    })).toThrow(/single-rename window/);

    // Prove the crashed on-disk state: store dir gone, backup present, key file gone
    // (it travelled into the backup with the store), no partial NEW/OLD split.
    expect(fs.existsSync(storeDir)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
    const bakName = fs.readdirSync(tmpRoot).find((e) => e.startsWith('store.rotate-old-'));
    expect(bakName).toBeTruthy();
    expect(fs.readFileSync(path.join(tmpRoot, bakName!, '.passphrase'), 'utf8')).toBe(OLD_KEY);

    // Next run recovers: the backup (old store + old key) is restored intact, so the
    // store is readable under the OLD key again — strictly safer than the four-rename
    // non-colocated path, which can strand a NEW-key store beside an OLD key file.
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: emptyKeyDir });
    const rep = rotatePassphrase({ newPassphrase: 'colo-final' });
    expect(rep.committed).toBe(true);

    // Old ciphertext survived the round trip byte-for-byte through the backup, and the
    // retry re-keyed cleanly to the final key.
    expect(fileStore.get('agents-cli.secrets.prod.A')).toBe('value-a');
    expect(fileStore.get('agents-cli.secrets.prod.B')).toBe('value-b');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('colo-final');
    const encAfter = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encAfter, 'colo-final')).toBe('value-a');
    expect(fs.readdirSync(tmpRoot).filter((e) => e.includes('.rotate-'))).toEqual([]);
    // The store held the same item set before the crash and after recovery+retry.
    expect(fs.readdirSync(storeDir).filter((f) => f.endsWith('.enc')).sort())
      .toEqual(beforeStore.map(([f]) => f).filter((f) => f.endsWith('.enc')).sort());
  });

  it('copies a non-UTF-8 file through the rotation byte-for-byte (no U+FFFD corruption)', () => {
    seed('prod', 'A', 'value-a');
    // A raw binary blob with byte sequences that are not valid UTF-8 (0xff/0xfe are
    // never legal UTF-8 lead bytes; the lone 0x80 continuation is invalid too). A
    // decode/re-encode round-trip would replace each with U+FFFD and corrupt it.
    const rawName = 'not-utf8.bin';
    const rawBytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0xc3, 0x28, 0x99]);
    fs.writeFileSync(path.join(storeDir, rawName), rawBytes, { mode: 0o600 });

    const rep = rotatePassphrase({ newPassphrase: 'colo-bin' });
    expect(rep.committed).toBe(true);

    // The blob survived the whole-store rewrite byte-for-byte.
    const after = fs.readFileSync(path.join(storeDir, rawName));
    expect(Buffer.compare(after, rawBytes)).toBe(0);
    // And the real item was still re-keyed.
    const encA = JSON.parse(fs.readFileSync(path.join(storeDir, 'agents-cli.secrets.prod.A.enc'), 'utf8')) as EncFile;
    expect(decryptForFallback(encA, 'colo-bin')).toBe('value-a');
  });
});
