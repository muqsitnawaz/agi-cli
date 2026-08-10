/** Synced device approval/ignore policy and local registry reconciliation. */
import { readMeta, updateMeta } from '../state.js';
import {
  addIgnored,
  assertValidDeviceName,
  loadDevices,
  loadIgnored,
  removeDevice,
  removeIgnored,
  upsertDevice,
} from './registry.js';
import { localLoginUser, withDefaultUser } from './sync.js';
import { nodeToDeviceInput, parseTailscaleStatus, tailscaleStatusJson } from './tailscale.js';

export type DeviceDiscoveryStatus = 'approved' | 'ignored';

export interface DeviceDiscoveryReconcileResult {
  approved: string[];
  ignored: string[];
  registered: string[];
  unresolved: string[];
}

/** Read one portable decision. Absence means pending. */
export function getDeviceDiscoveryStatus(name: string): DeviceDiscoveryStatus | undefined {
  assertValidDeviceName(name);
  return loadDeviceDiscoveryPolicies().get(name);
}

/** Persist one portable decision in the central fleet manifest. */
export function setDeviceDiscoveryStatus(name: string, status: DeviceDiscoveryStatus | undefined): void {
  assertValidDeviceName(name);
  updateMeta((meta) => {
    const discovery = { ...meta.fleet?.discovery };
    if (status) discovery[name] = status;
    else delete discovery[name];
    const fleet = {
      ...meta.fleet,
      devices: meta.fleet?.devices ?? {},
      discovery: Object.keys(discovery).length > 0 ? discovery : undefined,
    };
    return { ...meta, fleet };
  });
}

/** Load every explicit decision from the synced central fleet manifest. */
export function loadDeviceDiscoveryPolicies(): Map<string, DeviceDiscoveryStatus> {
  const policies = new Map<string, DeviceDiscoveryStatus>();
  for (const [name, status] of Object.entries(readMeta().fleet?.discovery ?? {})) {
    assertValidDeviceName(name);
    if (status !== 'approved' && status !== 'ignored') {
      throw new Error(`Device discovery policy for '${name}' must be approved or ignored.`);
    }
    policies.set(name, status);
  }
  return policies;
}

/**
 * Apply synced intent to this machine's local registry. Approval resolves live
 * Tailscale metadata; ignore never needs the network. Missing approved peers are
 * reported as unresolved rather than written with invented connection details.
 */
export async function reconcileDeviceDiscoveryPolicies(): Promise<DeviceDiscoveryReconcileResult> {
  const policies = loadDeviceDiscoveryPolicies();
  const approved = [...policies].filter(([, s]) => s === 'approved').map(([n]) => n).sort();
  const ignored = [...policies].filter(([, s]) => s === 'ignored').map(([n]) => n).sort();

  for (const name of ignored) {
    await removeDevice(name);
    await addIgnored(name);
  }
  for (const name of approved) await removeIgnored(name);

  const registry = await loadDevices();
  const missing = approved.filter((name) => !registry[name]);
  if (missing.length === 0) return { approved, ignored, registered: [], unresolved: [] };

  let nodes;
  try {
    nodes = parseTailscaleStatus(tailscaleStatusJson());
  } catch {
    return { approved, ignored, registered: [], unresolved: missing };
  }
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const registered: string[] = [];
  const unresolved: string[] = [];
  const user = localLoginUser();
  for (const name of missing) {
    const node = byName.get(name);
    if (!node) {
      unresolved.push(name);
      continue;
    }
    await upsertDevice(name, withDefaultUser(nodeToDeviceInput(node), undefined, user));
    registered.push(name);
  }
  return { approved, ignored, registered, unresolved };
}
