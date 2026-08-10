/**
 * One-time migration to the current device-config + pins layout:
 *
 *   (a) central `fleet.devices.<name>.config` (the short-lived #2458 store)
 *       folds into each per-device doc's `config:` block — central wins
 *       (newest intent) — and is stripped from central;
 *   (b) legacy `.history/devices/auto-launch.json` flags fold into the doc
 *       `config:` too (oldest store — only fills keys not already set);
 *   (c) a top-level `defaultBrowserProfile:` in a device doc folds into that
 *       doc's `config:`;
 *   (d) agent pins (`agents:` / `isolatedAgents:`) leave the TRACKED
 *       per-device docs: THIS machine's pins move to the untracked
 *       `.history/devices/pins-<host>.json` (pins file wins on conflict — it
 *       is the destination); peers' pins are simply dropped from the tracked
 *       file (each peer owns/rewrites its own pins locally).
 *
 * What stays put: a device doc's existing `config:` (already the right home)
 * and its `routines:` list (operator-owned, read cross-device by
 * routine-activation.ts).
 *
 * Order is crash-safe: destination writes (pins file, device doc) land BEFORE
 * the source strip (central), so a crash mid-fold re-folds on the next run and
 * the destination-wins merges make that a no-op. Idempotent — after a
 * successful run none of the legacy locations hold data, so re-running is a
 * cheap existence check. A doc that fails to parse is LOUDLY skipped (left
 * untouched) so the next run retries — never silently emptied, same corruption
 * contract the device registry keeps.
 *
 * Invoked from three places so every install converges regardless of entry
 * point: `runMigration()` (fresh / sentinel-less installs), daemon boot, and
 * the first `lib/device-config.ts` read/write in a process.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  META_HEADER,
  getDevicesAutoLaunchPath,
  getDevicePinsPath,
  getUserAgentsDir,
  readMeta,
  updateMeta,
} from '../state.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { machineId } from '../machine-id.js';
import type { FleetDeviceOverride, FleetManifest } from '../fleet/types.js';

/** One parsed device doc under ~/.agents/devices/. */
interface DeviceDoc {
  name: string;
  path: string;
  doc: Record<string, unknown>;
}

/** Read every device doc. A doc that fails to parse is loudly skipped. */
function readDeviceDocs(devicesRoot: string): DeviceDoc[] {
  const docs: DeviceDoc[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesRoot, { withFileTypes: true });
  } catch {
    return docs; // no devices/ tree — nothing to fold
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const docPath = path.join(devicesRoot, entry.name, 'agents.yaml');
    if (!fs.existsSync(docPath)) continue;
    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(docPath, 'utf-8'));
    } catch (err) {
      console.error(`device config migration: could not parse ${docPath} (${(err as Error).message}); leaving it for a later retry`);
      continue;
    }
    if (parsed === null || parsed === undefined) continue; // empty doc
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`device config migration: ${docPath} is not a YAML map; leaving it for manual repair`);
      continue;
    }
    docs.push({ name: entry.name, path: docPath, doc: parsed as Record<string, unknown> });
  }
  return docs;
}

/** Write a device doc, or remove it (and its dir) when nothing remains. */
function writeDeviceDoc(docPath: string, doc: Record<string, unknown>): void {
  try {
    if (Object.keys(doc).length === 0) {
      fs.rmSync(docPath, { force: true });
      try {
        fs.rmdirSync(path.dirname(docPath));
      } catch { /* not empty — other files live in the device dir */ }
    } else {
      atomicWriteFileSync(docPath, META_HEADER + yaml.stringify(doc));
    }
  } catch (err) {
    console.error(`device config migration: could not rewrite ${docPath} (${(err as Error).message}); a later run retries`);
  }
}

/** The legacy auto-launch.json flags, keyed by device name ({} when absent). */
function readAutoLaunchFlags(autoLaunchPath: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(autoLaunchPath, 'utf-8');
  } catch {
    return out; // absent — nothing to fold
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`device config migration: could not parse ${autoLaunchPath} (${(err as Error).message}); leaving it for a later retry`);
    return out;
  }
  const devices = (parsed as { devices?: unknown })?.devices;
  if (devices && typeof devices === 'object' && !Array.isArray(devices)) {
    for (const [name, pref] of Object.entries(devices as Record<string, { enabled?: unknown; preferred?: unknown }>)) {
      const config: Record<string, unknown> = {};
      if (pref?.enabled === false) config.autoLaunchEnabled = false;
      if (pref?.preferred === true) config.autoLaunchPreferred = true;
      if (Object.keys(config).length > 0) out[name] = config;
    }
  }
  return out;
}

function isConfigMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fold every legacy device-config/pins location into the current layout. Safe
 * to call on every boot / config access: cheap no-op once folded.
 */
export function migrateDeviceConfigStores(): void {
  const devicesRoot = path.join(getUserAgentsDir(), 'devices');
  const autoLaunchPath = getDevicesAutoLaunchPath();
  const self = machineId();

  // ── 1. Gather ────────────────────────────────────────────────────────────
  // Central per-device config (the #2458 store).
  const fleet = readMeta().fleet;
  const centralDevices: Record<string, FleetDeviceOverride> =
    fleet && fleet.devices !== 'all' ? fleet.devices : {};
  const centralHasConfig = Object.values(centralDevices).some(
    (ov) => ov?.config && Object.keys(ov.config).length > 0,
  );

  const autoLaunchFlags = readAutoLaunchFlags(autoLaunchPath);
  const docs = readDeviceDocs(devicesRoot);

  const pinsPath = getDevicePinsPath();
  let selfPins: { agents?: Record<string, string>; isolatedAgents?: Record<string, string> } = {};
  try {
    selfPins = (JSON.parse(fs.readFileSync(pinsPath, 'utf-8')) as typeof selfPins) || {};
  } catch { /* absent or malformed — the fold below recreates it */ }

  // Anything to do?
  const docsNeedingWork = docs.filter(
    ({ doc }) =>
      doc.config !== undefined ||
      typeof doc.defaultBrowserProfile === 'string' ||
      doc.agents !== undefined ||
      doc.isolatedAgents !== undefined,
  );
  const autoLaunchPending = fs.existsSync(autoLaunchPath) && Object.keys(autoLaunchFlags).length > 0;
  if (!centralHasConfig && !autoLaunchPending && docsNeedingWork.length === 0 && !fs.existsSync(autoLaunchPath)) {
    return;
  }

  // ── 2. Destination writes FIRST (crash-safe) ─────────────────────────────
  // 2a. THIS machine's pins: doc pins merge INTO the pins file (pins file
  //     wins — it is the destination, and a re-fold after a crash must not
  //     clobber pins the new CLI already wrote).
  const selfDoc = docs.find((d) => d.name === self);
  const docAgents = isConfigMap(selfDoc?.doc.agents) ? (selfDoc!.doc.agents as Record<string, string>) : undefined;
  const docIsolated = isConfigMap(selfDoc?.doc.isolatedAgents)
    ? (selfDoc!.doc.isolatedAgents as Record<string, string>)
    : undefined;
  if (docAgents || docIsolated) {
    const pins: typeof selfPins = { ...selfPins };
    if (docAgents) pins.agents = { ...docAgents, ...selfPins.agents };
    if (docIsolated) pins.isolatedAgents = { ...docIsolated, ...selfPins.isolatedAgents };
    try {
      fs.mkdirSync(path.dirname(pinsPath), { recursive: true });
      atomicWriteFileSync(pinsPath, JSON.stringify(pins, null, 2) + '\n');
    } catch (err) {
      console.error(`device config migration: could not write ${pinsPath} (${(err as Error).message}); a later run retries`);
    }
  }

  // 2b. Each device doc: merge config layers (auto-launch flags < existing doc
  //     config < central #2458 config — newest wins), fold the top-level
  //     defaultBrowserProfile, and strip pins from the tracked file.
  for (const { name, path: docPath, doc } of docs) {
    const config: Record<string, unknown> = {};
    // Oldest layer first: auto-launch.json flags.
    Object.assign(config, autoLaunchFlags[name]);
    // The doc's own config: block.
    if (doc.config !== undefined) {
      if (!isConfigMap(doc.config)) {
        console.error(`device config migration: ${docPath} has a non-map config: block; leaving it for manual repair`);
        continue;
      }
      Object.assign(config, doc.config);
    }
    if (typeof doc.defaultBrowserProfile === 'string' && config.defaultBrowserProfile === undefined) {
      config.defaultBrowserProfile = doc.defaultBrowserProfile;
    }
    // Newest layer: the central #2458 block for this device.
    const centralConfig = centralDevices[name]?.config;
    if (isConfigMap(centralConfig)) Object.assign(config, centralConfig);

    const next: Record<string, unknown> = {};
    // Preserve fields the migration does not own (routines:, anything else).
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'config' || k === 'defaultBrowserProfile' || k === 'agents' || k === 'isolatedAgents') continue;
      next[k] = v;
    }
    if (Object.keys(config).length > 0) next.config = config;

    const changed =
      doc.config !== undefined ||
      typeof doc.defaultBrowserProfile === 'string' ||
      doc.agents !== undefined ||
      doc.isolatedAgents !== undefined ||
      isConfigMap(centralConfig) ||
      autoLaunchFlags[name] !== undefined;
    if (changed) writeDeviceDoc(docPath, next);
  }

  // A device that has central/auto-launch config but NO doc yet gets one.
  const docNames = new Set(docs.map((d) => d.name));
  for (const [name, centralOv] of Object.entries(centralDevices)) {
    if (docNames.has(name) || !isConfigMap(centralOv?.config)) continue;
    const config = { ...autoLaunchFlags[name], ...centralOv.config };
    writeDeviceDoc(path.join(devicesRoot, name, 'agents.yaml'), { config });
  }
  for (const [name, flags] of Object.entries(autoLaunchFlags)) {
    if (docNames.has(name) || (centralDevices[name]?.config && isConfigMap(centralDevices[name].config))) continue;
    writeDeviceDoc(path.join(devicesRoot, name, 'agents.yaml'), { config: { ...flags } });
  }

  // ── 3. Source strips LAST ────────────────────────────────────────────────
  // 3a. Central: drop every devices.<name>.config block (now folded into the
  //     device docs). Overrides left with no other fields are dropped; an
  //     emptied fleet block (no defaults/secrets/routines) goes away entirely.
  if (centralHasConfig) {
    updateMeta((m) => {
      const devices = m.fleet?.devices;
      if (!devices || devices === 'all') return m;
      const nextDevices: Record<string, FleetDeviceOverride> = {};
      for (const [name, ov] of Object.entries(devices)) {
        const rest = { ...ov };
        delete rest.config;
        if (Object.keys(rest).length > 0) nextDevices[name] = rest;
      }
      const fleet: FleetManifest = { ...m.fleet, devices: nextDevices };
      if (Object.keys(nextDevices).length === 0 && !fleet.defaults && !fleet.secrets && !fleet.routines) {
        const { fleet: _, ...rest } = m;
        void _;
        return rest;
      }
      return { ...m, fleet };
    });
  }

  // 3b. The legacy auto-launch.json.
  if (fs.existsSync(autoLaunchPath)) {
    try {
      fs.rmSync(autoLaunchPath, { force: true });
    } catch (err) {
      console.error(`device config migration: could not remove ${autoLaunchPath} (${(err as Error).message}); a later run retries`);
    }
  }
}
