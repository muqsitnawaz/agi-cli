/**
 * Device/user config keys — typed read/write over the three-layer store.
 *
 * One registry (`CONFIG_KEYS`) maps each CLI dotted name to where it lives:
 *   - user scope   → central `~/.agents/agents.yaml` under `config:` (syncs
 *                    fleet-wide via `agents repo push/pull`)
 *   - device scope → the per-device TRACKED doc
 *                    `~/.agents/devices/<name>/agents.yaml` under `config:` —
 *                    conflict-free by construction (each machine writes only
 *                    its own folder, and the churny auto-written pins no longer
 *                    share the file)
 *   - fleet layer  → central `~/.agents/agents.yaml` under
 *                    `fleet.defaults.config` — fleet-wide defaults written by
 *                    `agents devices config --fleet <key> <value>`
 *
 * Read order for a device-scope key: built-in default < fleet.defaults.config
 * < per-device config:. Names and non-secret values only (a secrets-bundle
 * NAME is fine; a credential never is).
 *
 * The device registry (`~/.agents/.history/devices/registry.json`) stays the
 * DISCOVERY cache (address, tailscale snapshot, reachability); the profile
 * fields config can override (ssh.*, platform, user) are overlaid onto it at
 * read time by `lib/devices/resolve-profile.ts`.
 *
 * Legacy stores (central `fleet.devices.<name>.config`, legacy auto-launch.json,
 * doc-level defaultBrowserProfile, pins in tracked docs) are folded into this
 * layout once by `lib/devices/config-migration.ts`, invoked on the first
 * read/write in a process — after migration there is ONE read path per layer,
 * no fallback branches.
 *
 * Unset always means today's behavior (the documented default).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { META_HEADER, getUserAgentsDir, readMeta, updateMeta, withMetaLock } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { machineId } from './machine-id.js';
import { assertValidDeviceName } from './devices/registry.js';
import { migrateDeviceConfigStores } from './devices/config-migration.js';
import type { FleetManifest } from './fleet/types.js';

/** Which tier of the agents.yaml store a key lives in. */
export type ConfigScope = 'user' | 'device';

/** Value type of a config key — drives validation and `--json` rendering. */
export type ConfigType = 'string' | 'int' | 'bool' | 'string-list';

/** One known config key. */
export interface ConfigKeySpec {
  /** CLI dotted name, e.g. `interactive.host`. */
  name: string;
  /** camelCase key under the YAML config block. */
  yamlKey: string;
  scope: ConfigScope;
  type: ConfigType;
  /** One-line description for help/list output. */
  description: string;
  /** The effective value when the key is unset (bool keys; drives the interactive menu's default). */
  defaultValue?: unknown;
  /** Extra validation beyond the type check; return an error string or null. */
  validate?: (value: unknown) => string | null;
}

/** Which layer set a key's effective value (`default` = unset, built-in behavior). */
export type ConfigSource = 'user' | 'device' | 'fleet' | 'default';

/** A key with its resolved value and the layer that set it. */
export interface ConfigEntry {
  spec: ConfigKeySpec;
  /** The effective value, or undefined when unset (unset = default behavior). */
  value: unknown;
  /** Which layer set the effective value. */
  source: ConfigSource;
}

/** Options scoping a read/write: a specific device (default: this machine), or the fleet-defaults layer. */
export interface ConfigTarget {
  device?: string;
  /** Write/read the fleet-wide defaults layer (central fleet.defaults.config). */
  fleet?: boolean;
}

const DEVICE_PLATFORMS = ['windows', 'linux', 'macos', 'unknown'] as const;
const SSH_AUTH_METHODS = ['key', 'password'] as const;

export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    name: 'interactive.host',
    yamlKey: 'interactiveHost',
    scope: 'user',
    type: 'string',
    description:
      'Device that shows the user artifacts (browser opens, dashboards) — the "online macOS box" skills should use instead of guessing.',
    validate: (v) => {
      try {
        assertValidDeviceName(v as string);
        return null;
      } catch (err: any) {
        return err?.message ?? String(err);
      }
    },
  },
  {
    name: 'usage.primary-host',
    yamlKey: 'usagePrimaryHost',
    scope: 'user',
    type: 'string',
    description: 'Device whose usage snapshots are authoritative for fleet-wide usage reporting.',
    validate: (v) => {
      try {
        assertValidDeviceName(v as string);
        return null;
      } catch (err: any) {
        return err?.message ?? String(err);
      }
    },
  },
  {
    name: 'browser.profile',
    yamlKey: 'defaultBrowserProfile',
    scope: 'device',
    type: 'string',
    description:
      'Browser profile `agents browser start` resolves to without --profile (set via `agents browser profiles set-default`).',
  },
  {
    name: 'agents.max-concurrent',
    yamlKey: 'maxAgents',
    scope: 'device',
    type: 'int',
    description:
      'Cap on concurrent agents on this device. What counts toward it depends on the consumer: ' +
      'AGI EXT auto-launch counts device-wide running agents; teams placement counts the team’s own roster on the device.',
    validate: (v) => ((v as number) >= 1 ? null : 'agents.max-concurrent must be >= 1.'),
  },
  {
    name: 'scheduler.enabled',
    yamlKey: 'schedulerEnabled',
    scope: 'device',
    type: 'bool',
    defaultValue: true,
    description: 'Whether the routines scheduler (daemon) may fire on this device.',
  },
  {
    name: 'daemon.enabled',
    yamlKey: 'daemonEnabled',
    scope: 'device',
    type: 'bool',
    defaultValue: true,
    description:
      'Whether the daemon may run on this device at all (secrets broker, browser IPC, watchdog, and the ' +
      'routines scheduler). Disabling is the top-level kill switch: nothing auto-starts the daemon while it ' +
      'is set, including `routines add`/`routines start`/`routines catchup`/webhook triggers. ' +
      '`agents daemon start` still starts it explicitly.',
  },
  {
    name: 'watchdog.enabled',
    yamlKey: 'watchdogEnabled',
    scope: 'device',
    type: 'bool',
    defaultValue: false,
    description: 'Whether the daemon runs the watchdog pass on this device.',
  },
  {
    name: 'browser.remote-control',
    yamlKey: 'browserRemoteControl',
    scope: 'device',
    type: 'bool',
    defaultValue: false,
    description:
      "Whether other fleet machines may drive THIS device's browser over `browser --host <this-device>`. " +
      'Default off — a fleet-remote drive is refused until the owner runs `agents browser remote-control on`.',
  },
  {
    name: 'notes',
    yamlKey: 'notes',
    scope: 'device',
    type: 'string-list',
    description: 'Free-form operator notes about this device (one entry per `agents devices config <name> notes <text>`).',
  },
  {
    name: 'ssh.user',
    yamlKey: 'sshUser',
    scope: 'device',
    type: 'string',
    description: 'SSH login user for the device — overrides the registry profile’s user at dial time.',
  },
  {
    name: 'ssh.auth',
    yamlKey: 'sshAuth',
    scope: 'device',
    type: 'string',
    description: 'SSH auth method: `key` (ssh agent / on-disk keys) or `password` (pulled from a secrets bundle).',
    validate: (v) =>
      (SSH_AUTH_METHODS as readonly string[]).includes(v as string)
        ? null
        : `ssh.auth must be one of ${SSH_AUTH_METHODS.join(' | ')}.`,
  },
  {
    name: 'ssh.bundle',
    yamlKey: 'sshBundle',
    scope: 'device',
    type: 'string',
    description: 'Secrets bundle holding the SSH password (for ssh.auth=password). A bundle NAME — never a secret value.',
  },
  {
    name: 'ssh.bundle-key',
    yamlKey: 'sshBundleKey',
    scope: 'device',
    type: 'string',
    description: "Key within the bundle whose value is the password (default 'password').",
  },
  {
    name: 'ssh.identity-file',
    yamlKey: 'sshIdentityFile',
    scope: 'device',
    type: 'string',
    description: 'Explicit private-key path for key auth (passed to OpenSSH with IdentitiesOnly=yes).',
  },
  {
    name: 'platform',
    yamlKey: 'platform',
    scope: 'device',
    type: 'string',
    description: 'OS family of the device — picks PowerShell vs POSIX on the remote end. Overrides the discovered platform.',
    validate: (v) =>
      (DEVICE_PLATFORMS as readonly string[]).includes(v as string)
        ? null
        : `platform must be one of ${DEVICE_PLATFORMS.join(' | ')}.`,
  },
  {
    name: 'auto-launch.enabled',
    yamlKey: 'autoLaunchEnabled',
    scope: 'device',
    type: 'bool',
    defaultValue: true,
    description: 'Whether AGI EXT auto-launch may pick this device (default on).',
  },
  {
    name: 'auto-launch.preferred',
    yamlKey: 'autoLaunchPreferred',
    scope: 'device',
    type: 'bool',
    defaultValue: false,
    description: 'Boost this device in AGI EXT auto-launch ranking (default off).',
  },
];

/** Look up a key spec by CLI dotted name, or throw listing the known keys. */
export function configKeySpec(name: string): ConfigKeySpec {
  const spec = CONFIG_KEYS.find((k) => k.name === name);
  if (!spec) {
    throw new Error(
      `Unknown config key '${name}'. Known keys: ${CONFIG_KEYS.map((k) => k.name).join(', ')}.`,
    );
  }
  return spec;
}

/** Throw when `value` does not match the key's declared type or validation. */
function assertValidValue(spec: ConfigKeySpec, value: unknown): void {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Config key '${spec.name}' expects a non-empty string, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'int':
      if (!Number.isInteger(value)) {
        throw new Error(`Config key '${spec.name}' expects an integer, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new Error(`Config key '${spec.name}' expects a boolean, got ${JSON.stringify(value)}.`);
      }
      break;
    case 'string-list':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`Config key '${spec.name}' expects a list of strings, got ${JSON.stringify(value)}.`);
      }
      break;
  }
  const err = spec.validate?.(value);
  if (err) throw new Error(`Invalid value for '${spec.name}': ${err}`);
}

// ─── Migration hook ───────────────────────────────────────────────────────────

let migrationDone = false;

/**
 * Fold the legacy config/pins stores into the current layout, once per
 * process. A failure is loud but non-fatal — config reads must keep working,
 * and the next process retries the fold. Honors AGENTS_SKIP_MIGRATION=1, the
 * same gate bootstrap's runMigration uses (tests pin it so a fork never folds
 * the developer's real ~/.agents as a side effect).
 */
export function ensureDeviceConfigMigrated(): void {
  if (migrationDone || process.env.AGENTS_SKIP_MIGRATION === '1') return;
  try {
    migrateDeviceConfigStores();
    migrationDone = true;
  } catch (err: any) {
    console.error(`device config migration failed (${err?.message ?? err}); a later run retries`);
  }
}

// ─── Layer reads ──────────────────────────────────────────────────────────────

/** Path to a device's tracked operator doc (`devices/<name>/agents.yaml`). */
function deviceDocPath(device: string): string {
  return path.join(getUserAgentsDir(), 'devices', device, 'agents.yaml');
}

/**
 * Read a device's doc. Returns null when the file does not exist. A malformed
 * file is a hard error — silently returning null would let the next write wipe
 * the device's routines/config (same contract as routine-activation's reader).
 */
function readDeviceDoc(device: string): Record<string, unknown> | null {
  const p = deviceDocPath(device);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const corrupted = (detail: string) =>
    new Error(`Device config corrupted at ${p}: ${detail}. Inspect and restore from backup.`);
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: any) {
    throw corrupted(err?.message ?? String(err));
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corrupted(`expected a YAML map, got ${Array.isArray(parsed) ? 'a list' : JSON.stringify(parsed)}`);
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.config !== undefined && (typeof doc.config !== 'object' || doc.config === null || Array.isArray(doc.config))) {
    throw corrupted('config: must be a mapping');
  }
  return doc;
}

/** Write a device doc (atomic), preserving keys this module does not own
 * (`routines:`). A doc left empty is removed instead of leaving an empty
 * tracked file behind. */
function writeDeviceDoc(device: string, doc: Record<string, unknown>): void {
  const p = deviceDocPath(device);
  if (Object.keys(doc).length === 0) {
    try {
      fs.rmSync(p, { force: true });
      fs.rmdirSync(path.dirname(p));
    } catch { /* dir not empty, or the file was already gone */ }
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteFileSync(p, META_HEADER + yaml.stringify(doc));
}

/** The fleet-defaults config layer (central `fleet.defaults.config`; {} when unset). */
export function readFleetConfigDefaults(): Record<string, unknown> {
  const config = readMeta().fleet?.defaults?.config;
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

/** The device layer only: the doc's `config:` block ({} when unset). */
function readDeviceDocConfig(device: string): Record<string, unknown> {
  return (readDeviceDoc(device)?.config as Record<string, unknown> | undefined) ?? {};
}

/**
 * The effective device-scope config block for `device`: fleet.defaults.config
 * overlaid with the per-device doc's config:. This is the single read path
 * post-migration — the profile resolver (`lib/devices/resolve-profile.ts`)
 * goes through here. Deliberately does NOT auto-trigger the migration: it
 * serves the hot dial/render paths. Sync and cheap (small local files).
 */
export function readDeviceConfigValues(device: string): Record<string, unknown> {
  return { ...readFleetConfigDefaults(), ...readDeviceDocConfig(device) };
}

/** The device a targeted read/write applies to (default: this machine). */
function targetDevice(opts?: ConfigTarget): string {
  return opts?.device ?? machineId();
}

/** Get one config key's effective value and the layer that set it. */
export function getConfigValue(name: string, opts?: ConfigTarget): ConfigEntry {
  ensureDeviceConfigMigrated();
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    const value = readMeta().config?.[spec.yamlKey];
    return { spec, value, source: value !== undefined ? 'user' : 'default' };
  }
  if (opts?.fleet) {
    const value = readFleetConfigDefaults()[spec.yamlKey];
    return { spec, value, source: value !== undefined ? 'fleet' : 'default' };
  }
  const docConfig = readDeviceDocConfig(targetDevice(opts));
  if (spec.yamlKey in docConfig) return { spec, value: docConfig[spec.yamlKey], source: 'device' };
  const fleetConfig = readFleetConfigDefaults();
  if (spec.yamlKey in fleetConfig) return { spec, value: fleetConfig[spec.yamlKey], source: 'fleet' };
  return { spec, value: undefined, source: 'default' };
}

/** List every known key with its effective value and the layer that set it. */
export function listConfig(opts?: ConfigTarget): ConfigEntry[] {
  return CONFIG_KEYS.map((spec) => getConfigValue(spec.name, opts));
}

/** List user-scope config keys with their values. Used to show inherited settings
 * in per-device views without implying those keys are device-local. */
export function listUserConfig(): ConfigEntry[] {
  return CONFIG_KEYS.filter((spec) => spec.scope === 'user').map((spec) => getConfigValue(spec.name));
}

/** Resolve the explicit usage host, falling back to the user's interactive host. */
export function resolveUsagePrimaryHost(): string | null {
  return (getConfigValue('usage.primary-host').value as string | undefined)
    ?? (getConfigValue('interactive.host').value as string | undefined)
    ?? null;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/** The fleet manifest for a defaults write: `devices` materializes as an
 * explicit empty map (NOT 'all') so `agents apply` targets nothing until the
 * operator declares a roster. */
function fleetForDefaultsWrite(fleet: FleetManifest | undefined): FleetManifest {
  return { ...fleet, devices: fleet && fleet.devices !== undefined ? fleet.devices : {} };
}

function setInFleetDefaults(spec: ConfigKeySpec, value: unknown): void {
  updateMeta((m) => {
    const fleet = fleetForDefaultsWrite(m.fleet);
    const defaults = { ...fleet.defaults, config: { ...fleet.defaults?.config, [spec.yamlKey]: value } };
    return { ...m, fleet: { ...fleet, defaults } };
  });
}

function unsetInFleetDefaults(spec: ConfigKeySpec): void {
  updateMeta((m) => {
    const stored = m.fleet?.defaults?.config;
    if (!stored || !(spec.yamlKey in stored)) return m; // nothing stored — no-op
    const config = { ...stored };
    delete config[spec.yamlKey];
    const defaults = { ...m.fleet!.defaults };
    if (Object.keys(config).length > 0) defaults.config = config;
    else delete defaults.config;
    const fleet: FleetManifest = { ...m.fleet!, devices: m.fleet!.devices };
    if (Object.keys(defaults).length > 0) fleet.defaults = defaults;
    else delete fleet.defaults;
    // Drop the fleet block entirely when the unset emptied a block that holds
    // nothing else — don't leave a vestigial `fleet: {devices: {}}` behind.
    const devicesEmpty = fleet.devices !== 'all' && Object.keys(fleet.devices).length === 0;
    if (devicesEmpty && !fleet.defaults && !fleet.secrets && !fleet.routines) {
      const { fleet: _, ...rest } = m;
      void _;
      return rest;
    }
    return { ...m, fleet };
  });
}

function setInDeviceDoc(device: string, spec: ConfigKeySpec, value: unknown): void {
  // The doc is shared with writeMetaUnlocked (which owns routines:) — the
  // read-modify-write runs under the meta lock so the two writers can't lose
  // each other's update across processes.
  withMetaLock(() => {
    const doc = readDeviceDoc(device) ?? {};
    doc.config = { ...(doc.config as Record<string, unknown> | undefined), [spec.yamlKey]: value };
    writeDeviceDoc(device, doc);
  });
}

function unsetInDeviceDoc(device: string, spec: ConfigKeySpec): void {
  withMetaLock(() => {
    const doc = readDeviceDoc(device);
    if (!doc) return; // nothing stored — unset is a no-op
    const config = doc.config as Record<string, unknown> | undefined;
    if (!config || !(spec.yamlKey in config)) return; // key not present — no write needed
    delete config[spec.yamlKey];
    if (Object.keys(config).length > 0) doc.config = config;
    else delete doc.config;
    writeDeviceDoc(device, doc);
  });
}

/**
 * Set a config key (validated). Device-scope keys target this machine unless
 * `opts.device` names a peer; `opts.fleet` writes the fleet-wide defaults layer
 * instead. User-scope keys reject `fleet` (they are already fleet-wide).
 */
export function setConfigValue(name: string, value: unknown, opts?: ConfigTarget): void {
  ensureDeviceConfigMigrated();
  const spec = configKeySpec(name);
  assertValidValue(spec, value);
  if (spec.scope === 'user') {
    if (opts?.fleet) {
      throw new Error(`Config key '${spec.name}' is user-scope (already fleet-wide) — --fleet does not apply.`);
    }
    updateMeta((m) => ({ ...m, config: { ...m.config, [spec.yamlKey]: value } }));
    return;
  }
  if (opts?.fleet) {
    setInFleetDefaults(spec, value);
    return;
  }
  setInDeviceDoc(targetDevice(opts), spec, value);
}

/** Unset a config key — restores the next layer down (fleet default, then the
 * built-in default). No-op when already unset at that layer. */
export function unsetConfigValue(name: string, opts?: ConfigTarget): void {
  ensureDeviceConfigMigrated();
  const spec = configKeySpec(name);
  if (spec.scope === 'user') {
    if (opts?.fleet) {
      throw new Error(`Config key '${spec.name}' is user-scope (already fleet-wide) — --fleet does not apply.`);
    }
    updateMeta((m) => {
      if (!m.config || !(spec.yamlKey in m.config)) return m;
      const next = { ...m.config };
      delete next[spec.yamlKey];
      return { ...m, config: Object.keys(next).length > 0 ? next : undefined };
    });
    return;
  }
  if (opts?.fleet) {
    unsetInFleetDefaults(spec);
    return;
  }
  unsetInDeviceDoc(targetDevice(opts), spec);
}

// ─── Auto-launch preferences (Factory auto-host selection) ────────────────────

/** A device's auto-launch flags, as read by Factory's launch ranking. */
export interface AutoLaunchPreference {
  enabled?: boolean;
  preferred?: boolean;
}

/** True if the device is enabled for auto-launch. Unset defaults to true. */
export function isAutoLaunchEnabled(name: string): boolean {
  assertValidDeviceName(name);
  return getConfigValue('auto-launch.enabled', { device: name }).value !== false;
}

/** Set whether a device is enabled for auto-launch. Setting the default
 * (enabled) removes the key to keep the doc minimal. */
export function setAutoLaunchEnabled(name: string, enabled: boolean): void {
  assertValidDeviceName(name);
  if (enabled) unsetConfigValue('auto-launch.enabled', { device: name });
  else setConfigValue('auto-launch.enabled', false, { device: name });
}

/** True if the device is preferred for auto-launch ranking. */
export function isAutoLaunchPreferred(name: string): boolean {
  assertValidDeviceName(name);
  return getConfigValue('auto-launch.preferred', { device: name }).value === true;
}

/** Set whether a device is preferred for auto-launch. Setting the default
 * (not preferred) removes the key to keep the doc minimal. */
export function setAutoLaunchPreferred(name: string, preferred: boolean): void {
  assertValidDeviceName(name);
  if (preferred) setConfigValue('auto-launch.preferred', true, { device: name });
  else unsetConfigValue('auto-launch.preferred', { device: name });
}

/**
 * Every device's effective auto-launch flags, keyed by device name — the shape
 * the menu-bar snapshot consumes. Layers like every other device-scope key: the
 * fleet default (central fleet.defaults.config) applies fleet-wide and the
 * per-device doc wins on conflict. `roster` (the registered device names) lets
 * a fleet default reach devices that have no doc of their own; without it only
 * devices with docs are listed.
 */
export function loadAutoLaunchPreferences(roster?: string[]): Record<string, AutoLaunchPreference> {
  ensureDeviceConfigMigrated();
  const fleet = readFleetConfigDefaults();
  const names = new Set(roster ?? []);
  if (!roster) {
    const devicesRoot = path.join(getUserAgentsDir(), 'devices');
    try {
      for (const entry of fs.readdirSync(devicesRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch { /* no devices/ tree — roster stays empty */ }
  }
  const out: Record<string, AutoLaunchPreference> = {};
  for (const name of names) {
    const doc = readDeviceDocConfig(name);
    const enabled = (doc.autoLaunchEnabled ?? fleet.autoLaunchEnabled) as boolean | undefined;
    const preferred = (doc.autoLaunchPreferred ?? fleet.autoLaunchPreferred) as boolean | undefined;
    const pref: AutoLaunchPreference = {};
    if (enabled === false) pref.enabled = false;
    if (preferred === true) pref.preferred = true;
    if (pref.enabled !== undefined || pref.preferred !== undefined) out[name] = pref;
  }
  return out;
}

// ─── Consumers' helpers ───────────────────────────────────────────────────────

/** True unless this machine's config disables the routines scheduler. */
export function isSchedulerEnabled(): boolean {
  return getConfigValue('scheduler.enabled').value !== false;
}

/**
 * Throw when the routines scheduler is disabled on this machine, naming the
 * setting and the fix. The single message every scheduler-start surface
 * (auto-start on `routines add`, manual `routines start`, the daemon's own
 * scheduler init) refuses with.
 */
export function assertSchedulerEnabled(): void {
  if (isSchedulerEnabled()) return;
  throw new Error(
    `The routines scheduler is disabled on this device (scheduler.enabled=false in ~/.agents/devices/${machineId()}/agents.yaml). ` +
      `Re-enable with: agents devices config ${machineId()} scheduler.enabled on`,
  );
}

/** True unless this machine's config disables the daemon outright (top-level kill switch). */
export function isDaemonEnabled(): boolean {
  return getConfigValue('daemon.enabled').value !== false;
}

/**
 * Throw when the daemon is disabled on this machine, naming the setting and
 * the fix. Every AUTO-start surface (routines add/start/catchup/webhook,
 * `ensureDaemonStarted`) refuses with this before calling `startDaemon()`.
 * `agents daemon start` is the deliberate override and does NOT call this —
 * disable only blocks auto-start, mirroring `systemctl disable`.
 */
export function assertDaemonEnabled(): void {
  if (isDaemonEnabled()) return;
  throw new Error(
    `The daemon is disabled on this device (daemon.enabled=false in ~/.agents/devices/${machineId()}/agents.yaml). ` +
      `Re-enable with: agents daemon enable`,
  );
}

/**
 * Read the effective `agents.max-concurrent` cap for each named device (fleet
 * defaults layered under the per-device doc; no SSH). Devices without a cap
 * are omitted — uncapped is the default. Used as an input to host ranking
 * (teams placement, AGI EXT auto-launch), never as a remote probe.
 */
export function readMaxConcurrentCaps(devices: string[]): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const device of devices) {
    const value = getConfigValue('agents.max-concurrent', { device }).value;
    if (typeof value === 'number') caps[device] = value;
  }
  return caps;
}
