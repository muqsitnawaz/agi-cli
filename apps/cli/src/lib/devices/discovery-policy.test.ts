import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home = '';

async function freshModules() {
  vi.resetModules();
  const policy = await import('./discovery-policy.js');
  const registry = await import('./registry.js');
  return { ...policy, ...registry };
}

function centralFile(): string {
  return path.join(home, '.agents', 'agents.yaml');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-policy-test-'));
  process.env.HOME = home;
  process.env.AGENTS_DEVICES_DIR = path.join(home, '.agents', '.history', 'devices');
});

afterEach(() => {
  delete process.env.AGENTS_DEVICES_DIR;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('synced device discovery policy', () => {
  it('round-trips approved, ignored, and pending while preserving sibling fleet config', async () => {
    const file = centralFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 2\n');
    const { getDeviceDiscoveryStatus, setDeviceDiscoveryStatus } = await freshModules();

    setDeviceDiscoveryStatus('mac-mini', 'approved');
    expect(getDeviceDiscoveryStatus('mac-mini')).toBe('approved');
    expect(fs.readFileSync(file, 'utf-8')).toContain('maxAgents: 2');

    setDeviceDiscoveryStatus('mac-mini', 'ignored');
    expect(getDeviceDiscoveryStatus('mac-mini')).toBe('ignored');

    setDeviceDiscoveryStatus('mac-mini', undefined);
    expect(getDeviceDiscoveryStatus('mac-mini')).toBeUndefined();
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('discovery:');
    expect(fs.readFileSync(file, 'utf-8')).toContain('maxAgents: 2');
  });

  it('applies an ignored synced decision to the real local registry and ignore-list', async () => {
    const { getDevice, isIgnored, reconcileDeviceDiscoveryPolicies, setDeviceDiscoveryStatus, upsertDevice } = await freshModules();
    await upsertDevice('mac-mini', {
      platform: 'macos',
      address: { via: 'tailscale', dnsName: 'mac-mini.example.ts.net' },
    });
    // A conflicting stale local state is exactly what pull reconciliation fixes.
    expect(await getDevice('mac-mini')).not.toBeNull();
    expect(await isIgnored('mac-mini')).toBe(false);
    setDeviceDiscoveryStatus('mac-mini', 'ignored');

    const result = await reconcileDeviceDiscoveryPolicies();

    expect(result).toMatchObject({ ignored: ['mac-mini'], registered: [], unresolved: [] });
    expect(await getDevice('mac-mini')).toBeNull();
    expect(await isIgnored('mac-mini')).toBe(true);
  });

  it('applies approval by clearing a stale local ignore without rewriting connection metadata', async () => {
    const { addIgnored, getDevice, isIgnored, reconcileDeviceDiscoveryPolicies, setDeviceDiscoveryStatus, upsertDevice } = await freshModules();
    await upsertDevice('zion', {
      platform: 'macos',
      user: 'operator',
      address: { via: 'manual', dnsName: 'zion.internal' },
    });
    await addIgnored('zion');
    setDeviceDiscoveryStatus('zion', 'approved');

    const result = await reconcileDeviceDiscoveryPolicies();

    expect(result).toMatchObject({ approved: ['zion'], registered: [], unresolved: [] });
    expect(await isIgnored('zion')).toBe(false);
    expect(await getDevice('zion')).toMatchObject({ user: 'operator', address: { dnsName: 'zion.internal' } });
  });
});
