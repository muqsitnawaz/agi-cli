import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let previousHome: string | undefined;

function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(value));
}

function deviceFile(device: string): string {
  return path.join(root, '.agents', 'devices', device, 'agents.yaml');
}

beforeEach(() => {
  previousHome = process.env.HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-registry-'));
  process.env.HOME = root;
  vi.resetModules();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe('profileRegistry', () => {
  it('unions declarations from every device without overwriting equal names', async () => {
    const chrome = { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] };
    writeYaml(deviceFile('alpha'), { browser: { shared: chrome, alpha: chrome } });
    writeYaml(deviceFile('beta'), { browser: { shared: chrome } });
    writeYaml(deviceFile('gamma'), { browser: { shared: chrome } });

    const { declaringDevices, profileKind, profileRegistry } = await import('./registry.js');
    const registry = profileRegistry();

    expect([...registry.keys()]).toEqual(['shared', 'alpha']);
    expect(registry.get('shared')?.map((entry) => entry.device)).toEqual(['alpha', 'beta', 'gamma']);
    expect(declaringDevices('alpha')).toEqual(['alpha']);
    expect(profileKind('alpha')).toBe('identity');
    expect(profileKind('shared')).toBe('fungible');
    expect(profileKind('missing')).toBeNull();
  });

  it('fails loudly when a device browser block is malformed', async () => {
    writeYaml(deviceFile('broken'), { browser: ['not', 'a', 'map'] });
    const { profileRegistry } = await import('./registry.js');
    expect(() => profileRegistry()).toThrow(/browser must be a map/);
  });
});

describe('central browser migration', () => {
  it('moves central declarations only into this device file and is idempotent', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
    writeYaml(centralFile, { browser: { 'comet-local': config }, model: { claude: 'opus' } });

    const { machineId } = await import('../machine-id.js');
    const { migrateCentralBrowserProfiles, profileRegistry } = await import('./registry.js');
    expect(migrateCentralBrowserProfiles()).toBe(true);

    const ownFile = deviceFile(machineId());
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8'))).toEqual({ model: { claude: 'opus' } });
    expect(yaml.parse(fs.readFileSync(ownFile, 'utf8')).browser).toEqual({ 'comet-local': config });
    expect(fs.readdirSync(path.join(root, '.agents', 'devices'))).toEqual([machineId()]);

    const centralAfterFirstRead = fs.readFileSync(centralFile, 'utf8');
    const deviceAfterFirstRead = fs.readFileSync(ownFile, 'utf8');
    expect(migrateCentralBrowserProfiles()).toBe(false);
    expect(profileRegistry().get('comet-local')?.map((entry) => entry.device)).toEqual([machineId()]);
    expect(fs.readFileSync(centralFile, 'utf8')).toBe(centralAfterFirstRead);
    expect(fs.readFileSync(ownFile, 'utf8')).toBe(deviceAfterFirstRead);
  });

  it('preserves both copies and fails when migration would overwrite a declaration', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    writeYaml(centralFile, {
      browser: { work: { browser: 'chrome', endpoints: ['cdp://localhost:9222'] } },
    });
    const { machineId } = await import('../machine-id.js');
    const ownFile = deviceFile(machineId());
    writeYaml(ownFile, {
      browser: { work: { browser: 'brave', endpoints: ['cdp://localhost:9333'] } },
    });

    const beforeCentral = fs.readFileSync(centralFile, 'utf8');
    const beforeDevice = fs.readFileSync(ownFile, 'utf8');
    const { migrateCentralBrowserProfiles } = await import('./registry.js');

    expect(() => migrateCentralBrowserProfiles()).toThrow(/different configurations/);
    expect(fs.readFileSync(centralFile, 'utf8')).toBe(beforeCentral);
    expect(fs.readFileSync(ownFile, 'utf8')).toBe(beforeDevice);
  });
});

describe('device declaration lifecycle', () => {
  it('round-trips create, read, and rename without losing configuration', async () => {
    const { machineId } = await import('../machine-id.js');
    const { createProfile, getProfile, renameProfile } = await import('./profiles.js');
    const input = {
      name: 'remote-work',
      browser: 'custom' as const,
      description: 'credential browser',
      endpoints: ['ssh://browser-host?port=9344'],
      secrets: 'browser-login',
      viewport: { width: 1440, height: 900 },
    };

    await createProfile(input);
    expect(await getProfile(input.name)).toMatchObject({ ...input, devices: [machineId()] });

    await renameProfile(input.name, 'remote-renamed');
    expect(await getProfile(input.name)).toBeNull();
    expect(await getProfile('remote-renamed')).toMatchObject({
      ...input,
      name: 'remote-renamed',
      devices: [machineId()],
    });
  });

  it('refuses to mutate a declaration owned by another device', async () => {
    writeYaml(deviceFile('peer'), {
      browser: { 'signed-in': { browser: 'custom', endpoints: ['ssh://browser-host?port=9355'] } },
    });
    const { updateProfile } = await import('./profiles.js');

    await expect(
      updateProfile({ name: 'signed-in', browser: 'custom', endpoints: ['ssh://browser-host?port=9355'] }),
    ).rejects.toThrow(/not declared on .*; declared on peer/);
  });
});

describe('profileRegistry does not claim central declarations', () => {
  it('leaves a legacy central profile undeclared instead of claiming it for this device', async () => {
    // The regression this guards: profileRegistry() used to call
    // migrateCentralBrowserProfiles() on every read, on every box. Every device
    // can read the central map, so whichever box read first CLAIMED the name --
    // profileKind() then reported `identity` and the daemon tunnelled to THAT
    // box. For `comet-local` at cdp://localhost:9333 that is a logged-out
    // headless chromium on a Linux worker answering to the name of the browser
    // holding five real logins, recorded as a stored fact. Resolution must fail
    // loudly instead, and the central entry must survive for the machine that
    // actually owns the browser to claim explicitly.
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
    writeYaml(centralFile, { browser: { 'comet-local': config } });

    const { machineId } = await import('../machine-id.js');
    const { profileRegistry, declaringDevices, profileKind } = await import('./registry.js');

    profileRegistry();

    expect(declaringDevices('comet-local')).toEqual([]);
    expect(profileKind('comet-local')).toBeNull();
    expect(fs.existsSync(deviceFile(machineId()))).toBe(false);
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8')).browser).toEqual({
      'comet-local': config,
    });
  });
});
