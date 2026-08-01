/**
 * Passphrase-encrypted file store for secrets — platform-neutral.
 *
 * An AES-256-GCM encrypted-file store under `~/.agents/.cache/secrets/`. The
 * encryption key is scrypt-derived from a passphrase read from
 * `AGENTS_SECRETS_PASSPHRASE` (preferred), a machine-local provisioned key, or
 * a TTY prompt. One `<item>.enc` JSON file per item, mode 0600.
 *
 * Two callers:
 *  - Linux (src/lib/secrets/linux.ts): the headless fallback when the default
 *    Secret Service collection is locked. Auto-provisions a machine-local
 *    passphrase so `agents secrets` works out of the box on a server.
 *  - macOS file-backed bundles (src/lib/secrets/bundles.ts): an explicit,
 *    opt-in non-biometry backend for headless/remote release runs. The bundle
 *    layer guards this path so it only activates with an explicit
 *    AGENTS_SECRETS_PASSPHRASE (or TTY) — never the silent machine-local
 *    auto-provision — so a remote box holds ciphertext only.
 *
 * The item-name scheme is shared with the keychain backend so a file-backed
 * item and its keychain twin carry identical names:
 *   `agents-cli.bundles.<name>` and `agents-cli.secrets.<bundle>.<key>`.
 */

import { execSync, spawnSync } from 'child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KeychainBackend } from './index.js';
import { encodePwshBase64 } from '../pwsh.js';

// ---------- file store location ----------

let fileDirOverride: string | null = null;
let passphraseDirOverride: string | null = null;
let cachedPassphrase: string | null = null;
let warnedAutoPassphrase = false;

export function fileDir(): string {
  return fileDirOverride ?? path.join(os.homedir(), '.agents', '.cache', 'secrets');
}

function ensureFileDir(): void {
  fs.mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
}

// ---------- passphrase ----------

/**
 * Windows has no `/dev/tty` and no POSIX `stty`, so the interactive prompt runs
 * through PowerShell's `Read-Host -AsSecureString` (which never echoes). The
 * secure string is marshaled back out and written to stdout, which we capture.
 * If PowerShell cannot run at all, fail with an actionable error rather than
 * letting `fs.openSync('/dev/tty')` throw a raw ENOENT. Reached only on the rare
 * interactive-Windows file-fallback path — the headless service-account case
 * (no TTY) auto-provisions a machine-local key and never gets here.
 */
function readPassphraseFromTtyWindows(): string {
  const script = `
$ErrorActionPreference = 'Stop'
$sec = Read-Host -AsSecureString -Prompt 'Enter AGENTS_SECRETS_PASSPHRASE'
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
`;
  // Not -NonInteractive: that flag would suppress the Read-Host prompt itself.
  const res = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encodePwshBase64(script)], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      'Could not prompt for a passphrase on Windows. Set AGENTS_SECRETS_PASSPHRASE ' +
      'to decrypt the file-backed secret store.'
    );
  }
  return (res.stdout?.toString() ?? '').replace(/\r?\n$/, '');
}

/**
 * Turn off terminal echo on the controlling TTY, or throw — fail CLOSED. If echo
 * cannot be disabled (`stty` missing, no controlling terminal) we must NOT fall
 * through and read the passphrase anyway: that echoes the secret to the screen
 * and into scrollback (RUSH-1764). Refuse and point the user at the environment
 * variable instead. `run` performs the echo-disable and throws iff it fails.
 * Exported so the fail-closed contract has direct test coverage.
 */
export function disableTtyEchoOrThrow(run: () => void): void {
  try {
    run();
  } catch {
    throw new Error(
      'Refusing to prompt for AGENTS_SECRETS_PASSPHRASE: terminal echo could not be ' +
      'disabled (stty unavailable or no controlling TTY), so the passphrase would be ' +
      'shown in cleartext. Set AGENTS_SECRETS_PASSPHRASE in the environment instead.'
    );
  }
}

function readPassphraseFromTty(): string {
  if (process.platform === 'win32') return readPassphraseFromTtyWindows();
  const fd = fs.openSync('/dev/tty', 'r+');
  let echoDisabled = false;
  try {
    fs.writeSync(fd, 'Enter AGENTS_SECRETS_PASSPHRASE: ');
    // Fail closed: if echo can't be turned off, abort rather than echo the secret.
    disableTtyEchoOrThrow(() => execSync('stty -echo < /dev/tty', { stdio: 'ignore' }));
    echoDisabled = true;
    let pass = '';
    const buf = Buffer.alloc(1);
    while (true) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString('utf8', 0, n);
      if (ch === '\n' || ch === '\r') break;
      pass += ch;
    }
    return pass;
  } finally {
    if (echoDisabled) {
      try { execSync('stty echo < /dev/tty', { stdio: 'ignore' }); } catch { /* best effort */ }
    }
    try { fs.writeSync(fd, '\n'); } catch { /* best effort */ }
    fs.closeSync(fd);
  }
}

/**
 * Directory for the auto-provisioned machine-local passphrase. Kept outside
 * `fileDir()` so a scan of the encrypted store never co-locates key + ciphertext.
 */
function passphraseDir(): string {
  return passphraseDirOverride ?? path.join(os.homedir(), '.agents', '.secrets-key');
}

function ensurePassphraseDir(): void {
  fs.mkdirSync(passphraseDir(), { recursive: true, mode: 0o700 });
}

/** Path of the auto-provisioned machine-local passphrase (not an `.enc` item). */
function passphraseFilePath(): string {
  return path.join(passphraseDir(), 'passphrase');
}

/** Legacy co-located path — read-only for machines provisioned before #479. */
function legacyPassphraseFilePath(): string {
  return path.join(fileDir(), '.passphrase');
}

/** True if a machine-local passphrase has already been provisioned. */
export function machinePassphraseExists(): boolean {
  return readMachinePassphrase() !== null;
}

function readMachinePassphrase(): string | null {
  for (const fp of [passphraseFilePath(), legacyPassphraseFilePath()]) {
    try {
      const p = fs.readFileSync(fp, 'utf8').trim();
      if (p.length > 0) return p;
    } catch {
      // try next location
    }
  }
  return null;
}

/**
 * Provision (or read back) a stable machine-local passphrase for the encrypted
 * file store, so `agents secrets` works out of the box on a headless box where
 * the keyring is locked and no AGENTS_SECRETS_PASSPHRASE is set.
 *
 * Security model: this is encryption-at-rest with the key held in a 0600 file —
 * the same posture as an SSH private key, and identical to the common
 * "export AGENTS_SECRETS_PASSPHRASE=… in ~/.zshenv (chmod 600)" workaround. The
 * keyring (key in a daemon's locked memory) is stronger but is unavailable
 * without a graphical/unlocked session. For an off-disk key, set
 * AGENTS_SECRETS_PASSPHRASE (it always takes precedence) or unlock the keyring.
 */
function provisionMachinePassphrase(): string {
  const existing = readMachinePassphrase();
  if (existing) return existing;

  ensurePassphraseDir();
  const generated = randomBytes(32).toString('base64');
  const fp = passphraseFilePath();
  try {
    // wx: fail if a concurrent process created it first (then we read theirs).
    fs.writeFileSync(fp, generated, { mode: 0o600, flag: 'wx' });
  } catch {
    const raced = readMachinePassphrase();
    if (raced) return raced;
    throw new Error(`Failed to provision machine-local passphrase at ${fp}.`);
  }
  if (!warnedAutoPassphrase) {
    warnedAutoPassphrase = true;
    process.stderr.write(
      `[agents] keyring locked and no AGENTS_SECRETS_PASSPHRASE set; provisioned a ` +
      `machine-local passphrase at ${fp} (mode 0600). Set AGENTS_SECRETS_PASSPHRASE ` +
      `for a key held off disk.\n`
    );
  }
  return generated;
}

/**
 * Resolve the passphrase for the encrypted file store.
 *
 * Order: AGENTS_SECRETS_PASSPHRASE > previously-provisioned machine-local key >
 * (interactive) TTY prompt > (headless) auto-provisioned machine-local key.
 *
 * `allowAutoProvision` (default true, used by the Linux fallback) controls the
 * last two steps. macOS file-backed bundles pass `false` so a missing
 * passphrase is a hard, explicit error instead of a silently provisioned
 * on-disk key — the caller (bundles.ts) guards this before we get here.
 */
export function getPassphrase(opts: { allowAutoProvision?: boolean } = {}): string {
  const allowAutoProvision = opts.allowAutoProvision ?? true;
  if (cachedPassphrase !== null) return cachedPassphrase;
  const env = process.env.AGENTS_SECRETS_PASSPHRASE;
  if (env && env.length > 0) {
    cachedPassphrase = env;
    return env;
  }
  // A previously-provisioned machine-local passphrase is this machine's stable
  // file-store key — prefer it for both interactive and headless runs so they
  // always agree (a TTY run won't re-prompt once the file exists).
  const onDisk = readMachinePassphrase();
  if (onDisk) {
    cachedPassphrase = onDisk;
    return onDisk;
  }
  if (!allowAutoProvision) {
    throw new Error(
      'AGENTS_SECRETS_PASSPHRASE is not set. A passphrase is required to decrypt ' +
      'this file-backed secret store.'
    );
  }
  // First run, no env, no provisioned key: prompt when interactive, otherwise
  // (headless — the reported bug) auto-provision instead of hard-failing.
  if (process.stdin.isTTY) {
    const p = readPassphraseFromTty();
    if (!p) throw new Error('No passphrase entered.');
    cachedPassphrase = p;
    return p;
  }
  cachedPassphrase = provisionMachinePassphrase();
  return cachedPassphrase;
}

// ---------- AES-256-GCM ----------

/** Encrypted-file on-disk shape. Exported for tests. */
export interface EncFile {
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

/** Encrypt plaintext under a passphrase using AES-256-GCM with a random
 *  scrypt salt and a random 96-bit IV. Exported for tests. */
export function encryptForFallback(plaintext: string, passphrase: string): EncFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/** Decrypt an EncFile under a passphrase. Throws on wrong key or tampered
 *  ciphertext (auth-tag mismatch). Exported for tests. */
export function decryptForFallback(enc: EncFile, passphrase: string): string {
  const salt = Buffer.from(enc.salt, 'hex');
  const iv = Buffer.from(enc.iv, 'hex');
  const authTag = Buffer.from(enc.authTag, 'hex');
  const ciphertext = Buffer.from(enc.ciphertext, 'hex');
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// ---------- file backend ----------

function fileFor(item: string): string {
  return path.join(fileDir(), `${item}.enc`);
}

function fileHas(item: string): boolean {
  return fs.existsSync(fileFor(item));
}

function fileGet(item: string, opts: { allowAutoProvision?: boolean } = {}): string {
  const fp = fileFor(item);
  if (!fs.existsSync(fp)) {
    throw new Error(`Secret '${item}' not found in encrypted store.`);
  }
  const raw = fs.readFileSync(fp, 'utf8');
  let parsed: EncFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Encrypted secret file ${fp} is corrupt (not valid JSON).`);
  }
  try {
    return decryptForFallback(parsed, getPassphrase(opts));
  } catch {
    throw new Error(
      `Failed to decrypt '${item}'. Wrong AGENTS_SECRETS_PASSPHRASE or tampered file.`
    );
  }
}

function fileSet(item: string, value: string, opts: { allowAutoProvision?: boolean } = {}): void {
  ensureFileDir();
  const enc = encryptForFallback(value, getPassphrase(opts));
  fs.writeFileSync(fileFor(item), JSON.stringify(enc), { mode: 0o600 });
}

function fileDelete(item: string): boolean {
  const fp = fileFor(item);
  if (!fs.existsSync(fp)) return true; // idempotent, matches secret-tool clear
  fs.unlinkSync(fp);
  return true;
}

function fileList(prefix: string): string[] {
  const dir = fileDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.slice(0, -'.enc'.length))
    .filter((name) => name.startsWith(prefix));
}

/** True if the fallback dir has any committed encrypted items. */
export function fileStoreHasItems(): boolean {
  try {
    return fs.readdirSync(fileDir()).some((e) => e.endsWith('.enc'));
  } catch {
    return false;
  }
}

/** Low-level file-store ops, exported so callers (linux fallback, macOS
 *  file-backed bundles) can opt into or out of passphrase auto-provision. */
export const fileStore = {
  has: fileHas,
  get: fileGet,
  set: fileSet,
  delete: fileDelete,
  list: fileList,
};

/** File-only KeychainBackend (exported for tests; the Linux backend uses these
 *  ops with auto-provision allowed). */
export const fileBackend: KeychainBackend = {
  has: fileHas,
  get: (item: string) => fileGet(item),
  set: (item: string, value: string) => fileSet(item, value),
  delete: fileDelete,
  list: fileList,
};

/** Resolved passphrase directory (exported for integration tests). */
export function resolvePassphraseDir(): string {
  return passphraseDir();
}

// ---------- passphrase rotation (RUSH-1975) ----------

/**
 * Path of the machine-local passphrase file that currently holds the file-store
 * key, or null if none is provisioned. Prefers the canonical #479 location and
 * falls back to the legacy co-located path, mirroring `readMachinePassphrase`.
 */
export function machinePassphraseSourcePath(): string | null {
  for (const fp of [passphraseFilePath(), legacyPassphraseFilePath()]) {
    try {
      if (fs.readFileSync(fp, 'utf8').trim().length > 0) return fp;
    } catch {
      // try next location
    }
  }
  return null;
}

/** Outcome of a `rotatePassphrase` run. Carries no secret material. */
export interface RotatePassphraseReport {
  /** True when nothing was written (report-only). */
  dryRun: boolean;
  /** True when the store was re-encrypted and the key file swapped. */
  committed: boolean;
  /** Encrypted items that decrypt under the current key and were (or would be) re-keyed. */
  bundleCount: number;
  /** `.enc` files that do NOT decrypt under the current key — left untouched, never re-keyed. */
  skipped: string[];
  /** Every re-keyed item round-tripped (decrypt) under the new key before any swap. */
  roundTripOk: boolean;
  /** The machine-local passphrase file that was (or would be) rewritten in place. */
  keyFilePath: string;
}

/** Flush a file's data to disk (durability before the atomic swap). */
function writeFileFsync(fp: string, data: string, mode: number): void {
  const fd = fs.openSync(fp, 'w', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // A freshly-created file needs its mode set explicitly — the open() mode is
  // masked by the process umask, so 0600 is not guaranteed by the flag alone.
  try { fs.chmodSync(fp, mode); } catch { /* best effort on platforms without chmod */ }
}

/** fsync a directory so a rename/create in it is durable. Best-effort: some
 *  filesystems reject O_RDONLY fsync on a directory. */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // filesystem doesn't support directory fsync — the rename is still ordered
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Recover from a rotation that was interrupted mid-swap on a prior run, so the
 * store is always left in a single, readable state. The swap sequence moves the
 * live store aside to a `<dir>.rotate-old-*` backup before moving the staged
 * store into place; a crash in the sub-millisecond gap between those two renames
 * would leave the store dir missing with its content safe in the backup. This
 * restores it, and sweeps abandoned `<dir>.rotate-*` staging/backup dirs and the
 * `<key>.rotate-*` temp files. Idempotent; a no-op when nothing was interrupted.
 */
function recoverInterruptedRotation(keyPath: string): void {
  const dir = fileDir();
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  let entries: string[];
  try { entries = fs.readdirSync(parent); } catch { return; }
  // If the live store dir vanished mid-swap, restore it from its backup.
  if (!fs.existsSync(dir)) {
    const bak = entries.find((e) => e.startsWith(`${base}.rotate-old-`));
    if (bak) fs.renameSync(path.join(parent, bak), dir);
  }
  // Restore the key file if it was moved aside but the new one never landed.
  if (!fs.existsSync(keyPath) && fs.existsSync(`${keyPath}.rotate-oldkey`)) {
    fs.renameSync(`${keyPath}.rotate-oldkey`, keyPath);
  }
  // Sweep abandoned staging/backup dirs and key temp files — only ever safe to
  // drop once the live store + key file are both present again.
  if (fs.existsSync(dir) && fs.existsSync(keyPath)) {
    for (const e of fs.readdirSync(parent)) {
      if (e.startsWith(`${base}.rotate-`)) {
        try { fs.rmSync(path.join(parent, e), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    for (const suffix of ['.rotate-new', '.rotate-oldkey']) {
      try { fs.rmSync(`${keyPath}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Rotate the machine-local file-store passphrase: decrypt every `.enc` item
 * under the current key and re-encrypt it under a freshly generated one, then
 * swap both the ciphertext and the key file atomically.
 *
 * Safety contract (RUSH-1975):
 *  - Verify before writing: every re-keyed item must round-trip decrypt under
 *    the new key, and the re-keyed count must reconcile with the source, or the
 *    run aborts having written nothing.
 *  - Atomic: the new store is staged in a sibling temp dir, fsync'd, then swapped
 *    into place by directory rename; the new key file is fsync'd and swapped the
 *    same way. A crash before the swap leaves the old store and old key fully
 *    intact and readable; a crash inside the swap self-heals on the next run
 *    (see `recoverInterruptedRotation`). No half-re-keyed store is ever exposed.
 *  - No plaintext (secret value or passphrase) is ever written to disk, argv, or
 *    a log — only ciphertext is staged, and the new key lands only in the 0600
 *    key file.
 *  - Items that do not decrypt under the current key (orphan caches, stale test
 *    artifacts written under another key) are copied through verbatim, never
 *    re-keyed, and reported in `skipped`.
 *
 * `newPassphrase` and `onStagedBeforeCommit` are test seams: the former pins the
 * generated key so a test can assert the swap; the latter fires after staging
 * but before any swap, so a test can throw to simulate a mid-run crash and prove
 * the old store survives. `tamperStaged` forces a staged item to fail its
 * round-trip check, exercising the verify-before-swap abort.
 */
export function rotatePassphrase(opts: {
  dryRun?: boolean;
  newPassphrase?: string;
  onStagedBeforeCommit?: () => void;
  tamperStaged?: boolean;
} = {}): RotatePassphraseReport {
  const dryRun = opts.dryRun ?? false;
  const keyPath = machinePassphraseSourcePath();
  if (!keyPath) {
    throw new Error(
      'No machine-local passphrase to rotate. `rotate-passphrase` re-keys the ' +
      'file store\'s auto-provisioned key; none is provisioned on this machine.',
    );
  }
  recoverInterruptedRotation(keyPath);

  const oldPass = fs.readFileSync(keyPath, 'utf8').trim();
  if (!oldPass) throw new Error(`Machine-local passphrase file ${keyPath} is empty.`);
  const newPass = opts.newPassphrase ?? randomBytes(32).toString('base64');
  if (newPass === oldPass) throw new Error('New passphrase equals the current one — refusing a no-op rotation.');

  const dir = fileDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.enc'));
  } catch {
    names = [];
  }
  if (names.length === 0) {
    throw new Error(`No encrypted items in ${dir} — nothing to rotate.`);
  }

  // Phase 1 — decrypt-all, re-encrypt, re-verify in memory. Nothing on disk is
  // touched here, so any throw leaves the live store and key file untouched.
  const staged: Array<{ name: string; enc: string }> = [];
  const skipped: string[] = [];
  for (const name of names) {
    const raw = fs.readFileSync(path.join(dir, name), 'utf8');
    let parsed: EncFile;
    try { parsed = JSON.parse(raw); } catch { skipped.push(`${name} (not valid EncFile JSON)`); continue; }
    let plain: string;
    try { plain = decryptForFallback(parsed, oldPass); }
    catch { skipped.push(`${name} (does not decrypt under the current key — orphan)`); continue; }
    let reEnc = encryptForFallback(plain, newPass);
    if (opts.tamperStaged) reEnc = { ...reEnc, ciphertext: `00${reEnc.ciphertext.slice(2)}` };
    let check: string;
    try { check = decryptForFallback(reEnc, newPass); }
    catch { throw new Error(`Re-encryption of ${name} failed to verify under the new key — aborted, nothing written.`); }
    if (check !== plain) throw new Error(`Round-trip mismatch on ${name} — aborted, nothing written.`);
    staged.push({ name, enc: JSON.stringify(reEnc) });
  }
  if (staged.length === 0) {
    throw new Error('No item decrypted under the current machine-local key — aborted, nothing written.');
  }

  const report: RotatePassphraseReport = {
    dryRun,
    committed: false,
    bundleCount: staged.length,
    skipped,
    roundTripOk: true,
    keyFilePath: keyPath,
  };
  if (dryRun) return report;

  // Phase 2 — stage the complete replacement store in a sibling temp dir, fsync,
  // then swap. Orphans and any non-.enc files are copied through verbatim so the
  // swapped dir is a complete superset of the old one (nothing is dropped).
  const keyColocated = path.dirname(keyPath) === dir;
  const rand = randomBytes(6).toString('hex');
  const stageDir = `${dir}.rotate-${rand}`;
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  const stagedNames = new Set(staged.map((s) => s.name));
  for (const { name, enc } of staged) {
    writeFileFsync(path.join(stageDir, name), enc, 0o600);
  }
  for (const entry of fs.readdirSync(dir)) {
    if (stagedNames.has(entry)) continue;
    if (keyColocated && entry === path.basename(keyPath)) continue; // rewritten below, not copied
    const src = path.join(dir, entry);
    if (!fs.statSync(src).isFile()) continue;
    writeFileFsync(path.join(stageDir, entry), fs.readFileSync(src, 'utf8'), 0o600);
  }
  // A co-located legacy key travels with the store: write the new value into the
  // staged dir so a single directory swap commits both ciphertext and key.
  if (keyColocated) writeFileFsync(path.join(stageDir, path.basename(keyPath)), newPass, 0o600);
  fsyncDir(stageDir);

  // Test seam: simulate a crash after staging but before the swap. The live store
  // and key file are still untouched at this point.
  opts.onStagedBeforeCommit?.();

  // For a non-co-located key, stage the new key beside the old one first so the
  // swap is two quick renames with no I/O between them.
  const keyTmp = `${keyPath}.rotate-new`;
  if (!keyColocated) {
    writeFileFsync(keyTmp, newPass, 0o600);
    fsyncDir(path.dirname(keyPath));
  }

  // Swap. Move the live store aside, then the staged store into place. The gap
  // between these two renames is the only crash window that leaves the store dir
  // absent; recoverInterruptedRotation restores it from the backup on next run.
  const bakDir = `${dir}.rotate-old-${rand}`;
  fs.renameSync(dir, bakDir);
  fs.renameSync(stageDir, dir);
  fsyncDir(path.dirname(dir));
  const keyBak = `${keyPath}.rotate-oldkey`;
  if (!keyColocated) {
    fs.renameSync(keyPath, keyBak);
    fs.renameSync(keyTmp, keyPath);
    fsyncDir(path.dirname(keyPath));
  }

  // Verify a real read out of the now-live store under the new key. On failure,
  // roll the store (and key) back to the backup — the old passphrase still works.
  try {
    const probe = JSON.parse(fs.readFileSync(path.join(dir, staged[0].name), 'utf8')) as EncFile;
    decryptForFallback(probe, newPass);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(bakDir, dir);
    if (!keyColocated && fs.existsSync(keyBak)) {
      try { fs.rmSync(keyPath, { force: true }); } catch { /* may not exist */ }
      fs.renameSync(keyBak, keyPath);
    }
    throw new Error(`Post-swap verification failed; rolled back to the old key. (${(err as Error).message})`);
  }

  // Committed. Drop the old ciphertext and old key — both hold the retired key.
  fs.rmSync(bakDir, { recursive: true, force: true });
  if (!keyColocated) fs.rmSync(keyBak, { force: true });
  cachedPassphrase = newPass;
  report.committed = true;
  return report;
}

/** Test-only: reset module state (file dir + cached passphrase). */
export function _resetFileStoreForTest(opts: {
  fileDir?: string | null;
  passphraseDir?: string | null;
  passphrase?: string | null;
} = {}): void {
  fileDirOverride = opts.fileDir ?? null;
  if (opts.passphraseDir !== undefined) {
    passphraseDirOverride = opts.passphraseDir;
  } else if (opts.fileDir) {
    // Hermetic sibling when only the store dir is overridden (linux.test.ts).
    passphraseDirOverride = path.resolve(opts.fileDir, '..', `${path.basename(opts.fileDir)}-key`);
  } else {
    passphraseDirOverride = null;
  }
  cachedPassphrase = opts.passphrase ?? null;
  warnedAutoPassphrase = false;
}
