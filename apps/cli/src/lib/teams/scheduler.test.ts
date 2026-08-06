/**
 * Placement cascade — the create→pin→pool→local rules a user reasons about.
 * Pure functions, no I/O: exercises resolvePlacement + pickLeastLoaded directly.
 *
 * machineId() reads the real hostname; these tests use device names that are
 * definitely NOT the local machine (`box-a`/`box-b`/`box-c`) so the local-device
 * short-circuit never fires, keeping assertions host-independent.
 */
import { describe, it, expect } from 'vitest';
import {
  resolvePlacement,
  pickLeastLoaded,
  pickHealthiest,
  cappedDevices,
  type RosterEntry,
  type DeviceHealthInput,
  type HarnessAvailability,
} from './scheduler.js';
import { machineId } from '../machine-id.js';

const running = (hostName: string | null): RosterEntry => ({ hostName, status: 'running' });
const done = (hostName: string | null): RosterEntry => ({ hostName, status: 'completed' });

describe('resolvePlacement cascade', () => {
  it('1. explicit pin wins even with no pool', () => {
    expect(resolvePlacement({}, 'box-a', [])).toEqual({ device: 'box-a' });
  });

  it('1. explicit pin wins over a pool', () => {
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, 'box-b', [])).toEqual({ device: 'box-b' });
  });

  it('4. no pin + no pool → local (null)', () => {
    expect(resolvePlacement({}, null, [])).toEqual({ device: null });
    expect(resolvePlacement({ devices: [] }, null, [])).toEqual({ device: null });
  });

  it('2. pool of one → the whole team runs there', () => {
    expect(resolvePlacement({ devices: ['box-a'] }, null, [])).toEqual({ device: 'box-a' });
  });

  it('3. pool of many → least-loaded pick', () => {
    // box-a already has a running teammate, box-b is idle → pick box-b.
    const roster = [running('box-a')];
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, null, roster)).toEqual({ device: 'box-b' });
  });
});

describe('pickLeastLoaded', () => {
  it('picks the device with the fewest RUNNING teammates', () => {
    const roster = [running('box-a'), running('box-a'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b', 'box-c'], roster)).toBe('box-c');
  });

  it('ignores non-running teammates when counting load', () => {
    // box-a has 2 COMPLETED (not load) and box-b has 1 RUNNING → box-a is least-loaded.
    const roster = [done('box-a'), done('box-a'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-a');
  });

  it('breaks ties by pool order (first declared wins)', () => {
    expect(pickLeastLoaded(['box-a', 'box-b'], [])).toBe('box-a');
    expect(pickLeastLoaded(['box-b', 'box-a'], [])).toBe('box-b');
  });

  it('ignores roster entries for devices outside the pool', () => {
    // A teammate on some retired host must not skew the pool's load counts.
    const roster = [running('retired-host'), running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-b');
  });

  it('throws on an empty pool (caller must guard)', () => {
    expect(() => pickLeastLoaded([], [])).toThrow(/empty device pool/);
  });
});

describe('agents.max-concurrent caps (auto-pick only)', () => {
  it('excludes a device at its cap from the least-loaded pick', () => {
    // box-a is at its cap (2/2 running) → box-b wins despite ties-by-order.
    const roster = [running('box-a'), running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2 })).toBe('box-b');
  });

  it('keeps a device under its cap eligible', () => {
    const roster = [running('box-a')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2 })).toBe('box-b');
    // box-a 1/2 is NOT capped, but box-b at 0 is still less loaded — prove the
    // cap didn't exclude box-a by making box-b busier:
    const busier = [running('box-a'), running('box-b'), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], busier, { 'box-a': 2 })).toBe('box-a');
  });

  it('throws naming each cap and the fix when every device is capped', () => {
    const roster = [running('box-a'), running('box-a'), running('box-b')];
    expect(() => pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 }))
      .toThrow(/agents\.max-concurrent cap: box-a \(2\/2\), box-b \(1\/1\)/);
    expect(() => pickLeastLoaded(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 }))
      .toThrow(/agents devices configure <name> --max-agents N/);
  });

  it('cappedDevices reports the exclusion reason with live counts', () => {
    const roster = [running('box-a'), running('box-a'), done('box-b')];
    // box-b's COMPLETED teammate is not load — a 1-cap box-b is not capped.
    expect(cappedDevices(['box-a', 'box-b'], roster, { 'box-a': 2, 'box-b': 1 })).toEqual([
      { device: 'box-a', running: 2, cap: 2 },
    ]);
  });

  it('resolvePlacement passes caps through the least-loaded step', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a', 'box-b'] }, null, roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-b' });
  });

  it('never second-guesses an explicit pin, even onto a capped device', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a', 'box-b'] }, 'box-a', roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-a' });
  });

  it('never second-guesses a pool of one, even when capped', () => {
    const roster = [running('box-a')];
    expect(
      resolvePlacement({ devices: ['box-a'] }, null, roster, { maxConcurrent: { 'box-a': 1 } }),
    ).toEqual({ device: 'box-a' });
  });
});

describe('pickHealthiest — health-, load-, and harness-aware pick', () => {
  const H = (h: DeviceHealthInput): DeviceHealthInput => h;

  it('with no fleet data reduces to least-loaded (fewest running, ties by order)', () => {
    const roster = [running('box-a'), running('box-a'), running('box-b')];
    expect(pickHealthiest(['box-a', 'box-b', 'box-c'], roster)).toBe('box-c');
    expect(pickHealthiest(['box-a', 'box-b'], [])).toBe('box-a');
    expect(pickHealthiest(['box-b', 'box-a'], [])).toBe('box-b');
  });

  it('excludes an unreachable device from the pick', () => {
    const health = { 'box-a': H({ reachable: false }), 'box-b': H({ reachable: true, headroom: 'busy' }) };
    // box-a is first by order and 0-load, but unreachable → box-b wins.
    expect(pickHealthiest(['box-a', 'box-b'], [], { health })).toBe('box-b');
  });

  it('excludes an overloaded (headroom: loaded) device from the pick', () => {
    const health = { 'box-a': H({ reachable: true, headroom: 'loaded', loadPercent: 95 }), 'box-b': H({ reachable: true, headroom: 'busy', loadPercent: 60 }) };
    expect(pickHealthiest(['box-a', 'box-b'], [], { health })).toBe('box-b');
  });

  it('prefers the requested-agent-available device over an unknown one', () => {
    // box-a is idle + first, box-b is busier — but harness availability is the
    // top-priority key, so a proven-available box-b still loses to... no: box-a
    // is unknown, box-b is available → box-b wins despite being busier.
    const health = {
      'box-a': H({ reachable: true, headroom: 'idle', loadPercent: 5 }),
      'box-b': H({ reachable: true, headroom: 'busy', loadPercent: 60 }),
    };
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'unknown', 'box-b': 'available' };
    expect(pickHealthiest(['box-a', 'box-b'], [], { health, harness })).toBe('box-b');
  });

  it('among equally-available devices, ranks by lower load/memory', () => {
    const health = {
      'box-a': H({ reachable: true, headroom: 'busy', loadPercent: 70, memPercent: 30 }),
      'box-b': H({ reachable: true, headroom: 'light', loadPercent: 25, memPercent: 20 }),
    };
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'available', 'box-b': 'available' };
    // worst-signal: box-a=70, box-b=25 → box-b is roomier.
    expect(pickHealthiest(['box-a', 'box-b'], [], { health, harness })).toBe('box-b');
  });

  it('uses memory when it is the worse signal', () => {
    const health = {
      'box-a': H({ reachable: true, loadPercent: 10, memPercent: 90 }),
      'box-b': H({ reachable: true, loadPercent: 40, memPercent: 40 }),
    };
    // box-a worst=90 (mem), box-b worst=40 → box-b.
    expect(pickHealthiest(['box-a', 'box-b'], [], { health })).toBe('box-b');
  });

  it('breaks a load tie by fewer running teammates', () => {
    const roster = [running('box-a')];
    const health = {
      'box-a': H({ reachable: true, loadPercent: 30, memPercent: 30 }),
      'box-b': H({ reachable: true, loadPercent: 30, memPercent: 30 }),
    };
    expect(pickHealthiest(['box-a', 'box-b'], roster, { health })).toBe('box-b');
  });

  it('never excludes an unknown-harness device (cold cache is not proof)', () => {
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'unknown', 'box-b': 'unknown' };
    // No availability data at all → still picks (degrades to load/order), never throws.
    expect(pickHealthiest(['box-a', 'box-b'], [], { harness })).toBe('box-a');
  });

  it('excludes a provably-unavailable device but keeps an unknown one', () => {
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'unavailable', 'box-b': 'unknown' };
    expect(pickHealthiest(['box-a', 'box-b'], [], { harness })).toBe('box-b');
  });

  it('fails loud naming the agent when EVERY eligible device is unavailable', () => {
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'unavailable', 'box-b': 'unavailable' };
    expect(() => pickHealthiest(['box-a', 'box-b'], [], { harness, requestedLabel: 'claude@2.1.112' }))
      .toThrow(/No device in the team pool can run claude@2\.1\.112/);
    expect(() => pickHealthiest(['box-a', 'box-b'], [], { harness, requestedLabel: 'claude@2.1.112' }))
      .toThrow(/box-a, box-b/);
  });

  it('the loud unavailable message points at a real availability command', () => {
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'unavailable' };
    expect(() => pickHealthiest(['box-a', 'box-b'], [], {
      harness: { ...harness, 'box-b': 'unavailable' },
      availabilityHint: 'agents fleet status --verbose',
    })).toThrow(/agents fleet status --verbose/);
  });

  it('fails loud naming each drop reason when NO device is even eligible', () => {
    const health = {
      'box-a': H({ reachable: false }),
      'box-b': H({ reachable: true, headroom: 'loaded' }),
    };
    expect(() => pickHealthiest(['box-a', 'box-b'], [], { health, requestedLabel: 'codex' }))
      .toThrow(/No viable device in the team pool for codex/);
    expect(() => pickHealthiest(['box-a', 'box-b'], [], { health, requestedLabel: 'codex' }))
      .toThrow(/box-a \(unreachable\), box-b \(overloaded\)/);
  });

  it('an all-capped pool fails loud with the drop reason', () => {
    const roster = [running('box-a'), running('box-a'), running('box-b')];
    expect(() => pickHealthiest(['box-a', 'box-b'], roster, { maxConcurrent: { 'box-a': 2, 'box-b': 1 } }))
      .toThrow(/at max-concurrent cap \(2\/2\).*at max-concurrent cap \(1\/1\)/);
  });

  it('a cap excludes a device even when it is otherwise the healthiest', () => {
    const roster = [running('box-a')];
    const health = {
      'box-a': H({ reachable: true, headroom: 'idle', loadPercent: 5 }),
      'box-b': H({ reachable: true, headroom: 'busy', loadPercent: 60 }),
    };
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'available', 'box-b': 'available' };
    // box-a would win on every key, but it is at its 1/1 cap → box-b.
    expect(pickHealthiest(['box-a', 'box-b'], roster, { health, harness, maxConcurrent: { 'box-a': 1 } })).toBe('box-b');
  });

  it('ranks numeric load correctly (not string-coerced): 100 is worse than 7', () => {
    const health = {
      'box-a': H({ reachable: true, loadPercent: 100, memPercent: 100 }),
      'box-b': H({ reachable: true, loadPercent: 7, memPercent: 7 }),
    };
    // A naive array `<` would order "…,100,…" before "…,7,…"; a correct numeric
    // compare picks box-b.
    expect(pickHealthiest(['box-a', 'box-b'], [], { health })).toBe('box-b');
  });

  it('throws on an empty pool (caller must guard)', () => {
    expect(() => pickHealthiest([], [])).toThrow(/empty device pool/);
  });
});

describe('resolvePlacement routes step 3 through the health-aware pick', () => {
  it('uses harness availability when health/harness are supplied', () => {
    const health: Record<string, DeviceHealthInput> = {
      'box-a': { reachable: true, headroom: 'idle', loadPercent: 5 },
      'box-b': { reachable: true, headroom: 'busy', loadPercent: 60 },
    };
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'unavailable', 'box-b': 'available' };
    // box-a is idle + first, but can't run the agent → box-b.
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, null, [], { health, harness }))
      .toEqual({ device: 'box-b' });
  });

  it('falls back to least-loaded when no fleet data is supplied', () => {
    const roster = [running('box-a')];
    expect(resolvePlacement({ devices: ['box-a', 'box-b'] }, null, roster))
      .toEqual({ device: 'box-b' });
  });

  it('surfaces the loud failure when the pool cannot run the agent', () => {
    const harness: Record<string, HarnessAvailability> = { 'box-a': 'unavailable', 'box-b': 'unavailable' };
    expect(() => resolvePlacement({ devices: ['box-a', 'box-b'] }, null, [], { harness, requestedLabel: 'claude@2.1.112' }))
      .toThrow(/No device in the team pool can run claude@2\.1\.112/);
  });
});

describe('local teammates count against the local pool member', () => {
  it('a cap on the local device engages once local teammates reach it', () => {
    const self = machineId();
    const roster = [running(null), running(null)];
    expect(pickLeastLoaded([self, 'box-b'], roster, { [self]: 2 })).toBe('box-b');
  });

  it('mixed local + remote pool counts both sides', () => {
    const self = machineId();
    // self: 1 local running, box-b: 2 remote running → self is least-loaded.
    const roster = [running(null), running('box-b'), running('box-b')];
    expect(pickLeastLoaded([self, 'box-b'], roster)).toBe(self);
    expect(cappedDevices([self, 'box-b'], roster, { [self]: 1 })).toEqual([
      { device: self, running: 1, cap: 1 },
    ]);
  });

  it('an empty-string hostName is local too', () => {
    const self = machineId();
    const roster: RosterEntry[] = [{ hostName: '', status: 'running' }];
    expect(pickLeastLoaded([self, 'box-b'], roster, { [self]: 1 })).toBe('box-b');
  });

  it('ignores a local teammate when this machine is not in the pool', () => {
    // Today’s behavior preserved: roster entries outside the pool never skew it.
    const roster = [running(null), running('box-b')];
    expect(pickLeastLoaded(['box-a', 'box-b'], roster)).toBe('box-a');
  });
});
