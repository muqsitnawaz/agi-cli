import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as yaml from 'yaml';
import { getUserAgentsDir, readMeta, updateMeta } from '../state.js';
import type { BrowserProfileConfig, Meta } from '../types.js';

export interface ProfileDeclaration {
  device: string;
  config: BrowserProfileConfig;
}

type LegacyBrowserMeta = Meta & { browser?: Record<string, BrowserProfileConfig> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fold the legacy central `browser:` map into THIS device's declaration file.
 *
 * Never called implicitly, and that is the point. Every device can read the
 * central map, so an implicit claim races: whichever box happens to read first
 * claims the name, {@link profileKind} then reports it `identity`, and the
 * daemon tunnels to that box — which for a fleet-wide `cdp://localhost:*`
 * profile is a logged-out headless browser wearing a credentialed browser's
 * name. That is the exact bug this module exists to remove, and an implicit
 * migration would write it to disk as a stored fact.
 *
 * So the claim is an explicit operator action, run on the machine that actually
 * owns the browser. Until then the name is declared by nobody and resolution
 * fails loudly, which is the designed behavior: a clear error beats silently
 * resolving to the wrong browser.
 */
export function migrateCentralBrowserProfiles(): boolean {
  const meta = readMeta() as LegacyBrowserMeta;
  const central = meta.browser;
  if (!central || Object.keys(central).length === 0) return false;

  const local = meta.deviceBrowser ?? {};
  for (const [name, config] of Object.entries(central)) {
    const existing = local[name];
    if (existing && !isDeepStrictEqual(existing, config)) {
      throw new Error(
        `Cannot migrate browser profile "${name}": central agents.yaml and this device's ` +
          `agents.yaml declare different configurations. Resolve the duplicate before retrying.`,
      );
    }
  }

  updateMeta((current) => {
    const legacy = current as LegacyBrowserMeta;
    const { browser: _removed, ...withoutCentralBrowser } = legacy;
    return {
      ...withoutCentralBrowser,
      deviceBrowser: { ...central, ...current.deviceBrowser },
    } as Meta;
  });
  return true;
}

/**
 * Every profile any device declares, keyed by name to all declaring devices.
 * Reads every `devices/<name>/agents.yaml`; declarations never overwrite.
 */
export function profileRegistry(): Map<string, ProfileDeclaration[]> {
  const registry = new Map<string, ProfileDeclaration[]>();
  const devicesDir = path.join(getUserAgentsDir(), 'devices');
  if (!fs.existsSync(devicesDir)) return registry;

  const devices = fs
    .readdirSync(devicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const device of devices) {
    const file = path.join(devicesDir, device, 'agents.yaml');
    if (!fs.existsSync(file)) continue;

    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `Cannot read browser declarations from ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed == null) continue;
    if (!isRecord(parsed)) {
      throw new Error(`Cannot read browser declarations from ${file}: document root must be a map.`);
    }

    const browser = parsed.browser;
    if (browser == null) continue;
    if (!isRecord(browser)) {
      throw new Error(`Cannot read browser declarations from ${file}: browser must be a map.`);
    }

    for (const [name, config] of Object.entries(browser)) {
      if (!isRecord(config)) {
        throw new Error(`Cannot read browser declaration "${name}" from ${file}: profile must be a map.`);
      }
      const declarations = registry.get(name) ?? [];
      declarations.push({ device, config: config as unknown as BrowserProfileConfig });
      registry.set(name, declarations);
    }
  }

  return registry;
}

/** Devices declaring `name`, empty when nobody does. */
export function declaringDevices(name: string): string[] {
  return (profileRegistry().get(name) ?? []).map((declaration) => declaration.device);
}

/** Exactly one declaring device is identity-bearing; several are fungible. */
export function profileKind(name: string): 'identity' | 'fungible' | null {
  const count = profileRegistry().get(name)?.length ?? 0;
  if (count === 0) return null;
  return count === 1 ? 'identity' : 'fungible';
}
