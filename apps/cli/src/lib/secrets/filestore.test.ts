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

  it('throws when there is no machine-local passphrase to rotate', () => {
    seed('prod', 'A', 'value-a');
    fs.rmSync(keyFile);
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    expect(machinePassphraseSourcePath()).toBeNull();
    expect(() => rotatePassphrase()).toThrow(/machine-local passphrase/i);
  });
});
