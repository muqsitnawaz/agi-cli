/**
 * Persistence guarantees for the device ignore-list.
 *
 * The ignore-list lives in the central, TRACKED `~/.agents/agents.yaml` under
 * `fleet.ignored`, so a dismissal syncs fleet-wide. The real bugs to guard:
 *   1. addIgnored must survive a reload AND land in the tracked central file
 *      (the legacy store was the untracked .history/devices/ignored.json — a
 *      dismissal on one machine never reached any other).
 *   2. addIgnored is idempotent and removeIgnored is the exact inverse.
 *   3. A malformed fleet.ignored block throws rather than silently returning an
 *      empty set that the next write would clobber (the data-loss path,
 *      mirroring the registry).
 *   4. Each entry carries provenance (who ignored the node, when, on which
 *      machine) for the `agents devices ignored` surface.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

// Set HOME before state.ts loads so its module-level root picks up the override.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-ignored-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');
process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';

const { loadIgnored, loadIgnoredEntries, addIgnored, removeIgnored, isIgnored } = await import('./registry.js');
const { computePendingDevices } = await import('./sync.js');

function centralPath(): string {
  return path.join(TEST_HOME, '.agents', 'agents.yaml');
}
function legacyPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'ignored.json');
}
function readCentralFleet(): Record<string, any> | undefined {
  if (!fs.existsSync(centralPath())) return undefined;
  return yaml.parse(fs.readFileSync(centralPath(), 'utf-8'))?.fleet;
}

beforeEach(async () => {
  await fsp.rm(path.join(TEST_HOME, '.agents'), { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('device ignore-list (central fleet.ignored)', () => {
  it('returns an empty set when no ignore-list exists', async () => {
    expect([...(await loadIgnored())]).toEqual([]);
    expect(await loadIgnoredEntries()).toEqual([]);
  });

  it('persists a dismissal across reloads, in the TRACKED central file', async () => {
    await addIgnored('ipad165');
    expect(await isIgnored('ipad165')).toBe(true);
    // Fresh read from disk — not the in-memory set from addIgnored.
    expect([...(await loadIgnored())]).toEqual(['ipad165']);

    // The dismissal landed in tracked ~/.agents/agents.yaml, with provenance —
    // and the legacy untracked store was never written.
    const fleet = readCentralFleet();
    expect(fleet?.ignored).toHaveLength(1);
    expect(fleet?.ignored[0].name).toBe('ipad165');
    expect(fleet?.ignored[0].ignoredOn).toBe('testbox');
    expect(typeof fleet?.ignored[0].ignoredAt).toBe('string');
    expect(fs.existsSync(legacyPath())).toBe(false);
  });

  it('is idempotent, stores entries sorted, and keeps the first dismissal\'s provenance', async () => {
    await addIgnored('win-mini');
    await addIgnored('ipad165');
    const first = (await loadIgnoredEntries()).find((e) => e.name === 'win-mini');
    await addIgnored('win-mini');
    expect([...(await loadIgnored())]).toEqual(['ipad165', 'win-mini']);
    const again = (await loadIgnoredEntries()).find((e) => e.name === 'win-mini');
    expect(again).toEqual(first);
  });

  it('removeIgnored is the exact inverse and reports miss vs hit', async () => {
    await addIgnored('mac-mini');
    expect(await removeIgnored('mac-mini')).toBe(true);
    expect(await isIgnored('mac-mini')).toBe(false);
    expect(await removeIgnored('mac-mini')).toBe(false);
  });

  it('drops an emptied fleet block created only to hold the ignore-list', async () => {
    await addIgnored('mac-mini');
    expect(readCentralFleet()).toBeDefined();
    await removeIgnored('mac-mini');
    expect(readCentralFleet()).toBeUndefined();
  });

  it('throws on a corrupted store instead of silently emptying it', async () => {
    fs.mkdirSync(path.dirname(centralPath()), { recursive: true });
    fs.writeFileSync(centralPath(), 'fleet:\n  devices: {}\n  ignored: "not-a-list"\n');
    await expect(loadIgnored()).rejects.toThrow(/corrupted/);

    fs.writeFileSync(centralPath(), 'fleet:\n  devices: {}\n  ignored:\n    - name: ipad165\n');
    await expect(loadIgnored()).rejects.toThrow(/corrupted/);
  });

  it('keeps an ignored node subtracted from the discovery pending-diff', async () => {
    // The real runDeviceSync flow: loadIgnored() feeds computePendingDevices.
    const nodes = [
      { name: 'ipad165', platform: 'macos', online: true, direct: true, sharee: false },
      { name: 'newbox', platform: 'linux', online: true, direct: true, sharee: false },
    ] as const;
    expect(computePendingDevices([...nodes], [], await loadIgnored())).toEqual(['ipad165', 'newbox']);
    await addIgnored('ipad165');
    expect(computePendingDevices([...nodes], [], await loadIgnored())).toEqual(['newbox']);
  });
});
