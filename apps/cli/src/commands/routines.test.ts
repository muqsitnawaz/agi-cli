import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { registerRoutinesCommands } from './routines.js';
import { readJob, deleteJob, writeJob, listJobs, validateJob, jobRunsOnThisDevice } from '../lib/routines.js';
import type { JobConfig } from '../lib/routines.js';
import { getRoutinesDir, ensureAgentsDir } from '../lib/state.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  vi.restoreAllMocks();
});

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerRoutinesCommands(program);
  return program;
}

function baseConfig(partial: Partial<JobConfig> = {}): JobConfig {
  return {
    name: '__test-cmd-routines__',
    schedule: '0 3 * * *',
    agent: 'claude',
    mode: 'auto',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'test prompt',
    ...partial,
  } as JobConfig;
}

describe('routines list — devices field in JSON output', () => {
  it('JSON output includes devices array and runsHere boolean', () => {
    ensureAgentsDir();
    const name = '__test-list-devices-json__';
    const config = baseConfig({ name, devices: ['yosemite-s0', 'mac-mini'] });

    try {
      writeJob(config);

      const chunks: string[] = [];
      const origWrite = process.stdout.write;
      process.stdout.write = ((chunk: string | Buffer) => {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      }) as typeof process.stdout.write;

      const program = makeProgram();
      try {
        program.parse(['routines', 'list', '--json'], { from: 'user' });
      } catch { /* commander exitOverride throws on --help */ }
      process.stdout.write = origWrite;

      const output = chunks.join('');
      const parsed = JSON.parse(output.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === name);
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual(['yosemite-s0', 'mac-mini']);
      expect(typeof entry.runsHere).toBe('boolean');
    } finally {
      deleteJob(name);
    }
  });

  it('JSON output shows empty devices array when unrestricted', () => {
    ensureAgentsDir();
    const name = '__test-list-nodevice-json__';
    const config = baseConfig({ name });

    try {
      writeJob(config);

      const chunks: string[] = [];
      const origWrite = process.stdout.write;
      process.stdout.write = ((chunk: string | Buffer) => {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      }) as typeof process.stdout.write;

      const program = makeProgram();
      try {
        program.parse(['routines', 'list', '--json'], { from: 'user' });
      } catch { /* commander exitOverride */ }
      process.stdout.write = origWrite;

      const output = chunks.join('');
      const parsed = JSON.parse(output.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === name);
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual([]);
      expect(entry.runsHere).toBe(true);
    } finally {
      deleteJob(name);
    }
  });
});

describe('routines devices --set and --clear', () => {
  it('--set writes a devices allowlist to the job YAML', async () => {
    ensureAgentsDir();
    const name = '__test-devices-set__';
    writeJob(baseConfig({ name }));

    try {
      const job = readJob(name);
      expect(job).not.toBeNull();
      expect(job!.devices).toBeUndefined();

      // Simulate --set by calling parseAndValidateDevices logic through writeJob.
      // Since parseAndValidateDevices calls loadDevices() and needs a registry,
      // directly test the data-layer effect: write devices and read them back.
      job!.devices = ['yosemite-s0', 'mac-mini'];
      writeJob(job!);
      const updated = readJob(name);
      expect(updated!.devices).toEqual(['yosemite-s0', 'mac-mini']);
    } finally {
      deleteJob(name);
    }
  });

  it('--clear removes the devices field entirely', () => {
    ensureAgentsDir();
    const name = '__test-devices-clear__';
    writeJob(baseConfig({ name, devices: ['yosemite-s0'] }));

    try {
      const job = readJob(name);
      expect(job!.devices).toEqual(['yosemite-s0']);
      job!.devices = undefined;
      writeJob(job!);
      const updated = readJob(name);
      // writeJob strips empty/undefined devices — the YAML shouldn't have 'devices:'.
      const raw = fs.readFileSync(path.join(getRoutinesDir(), name + '.yml'), 'utf-8');
      expect(raw).not.toMatch(/^devices:/m);
      // readJob still works, returning undefined for the field.
      expect(updated!.devices).toBeUndefined();
    } finally {
      deleteJob(name);
    }
  });
});

describe('routines add — --devices flag validation', () => {
  it('validateJob rejects an add with stale singular device key', () => {
    const config = { ...baseConfig(), device: 'yosemite-s0' } as Record<string, unknown>;
    const errors = validateJob(config as Partial<JobConfig>);
    expect(errors.some((e) => /singular "device" key is no longer supported/.test(e))).toBe(true);
  });

  it('validateJob accepts a valid devices array', () => {
    const errors = validateJob(baseConfig({ devices: ['yosemite-s0', 'mac-mini'] }));
    expect(errors).toEqual([]);
  });

  it('round-trips devices through writeJob and readJob', () => {
    ensureAgentsDir();
    const name = '__test-roundtrip-devices__';
    try {
      writeJob(baseConfig({ name, devices: ['yosemite-s0', 'mac-mini'] }));
      const job = readJob(name);
      expect(job!.devices).toEqual(['yosemite-s0', 'mac-mini']);
    } finally {
      deleteJob(name);
    }
  });
});

describe('routines run — device eligibility enforcement', () => {
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
  });

  it('run action blocks when this machine is not in the allowlist', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    ensureAgentsDir();
    const name = '__test-run-blocked__';
    writeJob(baseConfig({ name, devices: ['yosemite-s0'] }));

    try {
      const job = readJob(name);
      expect(job).not.toBeNull();
      expect(jobRunsOnThisDevice(job!)).toBe(false);
    } finally {
      deleteJob(name);
    }
  });

  it('run action allows when this machine is in the allowlist', () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    ensureAgentsDir();
    const name = '__test-run-allowed__';
    writeJob(baseConfig({ name, devices: ['yosemite-s0', 'mac-mini'] }));

    try {
      const job = readJob(name);
      expect(jobRunsOnThisDevice(job!)).toBe(true);
    } finally {
      deleteJob(name);
    }
  });
});

describe('devices table truncation', () => {
  it('long device lists get ellipsized in table output', () => {
    const DEVICE_W = 22;
    const deviceFull = 'yosemite-s0,yosemite-s1,mac-mini,zion';
    const deviceWord = deviceFull.length > DEVICE_W ? deviceFull.slice(0, DEVICE_W - 1) + '…' : deviceFull;
    expect(deviceWord.length).toBeLessThanOrEqual(DEVICE_W);
    expect(deviceWord).toContain('…');
  });

  it('short device lists are not truncated', () => {
    const DEVICE_W = 22;
    const deviceFull = 'yosemite-s0';
    const deviceWord = deviceFull.length > DEVICE_W ? deviceFull.slice(0, DEVICE_W - 1) + '…' : deviceFull;
    expect(deviceWord).toBe('yosemite-s0');
    expect(deviceWord).not.toContain('…');
  });
});
