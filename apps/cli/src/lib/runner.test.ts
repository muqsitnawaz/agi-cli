import { afterEach, describe, expect, it } from 'vitest';
import { executeJob, executeJobDetached } from './runner.js';
import type { JobConfig } from './routines.js';

function baseConfig(partial: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 3 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'do it',
    ...partial,
  } as JobConfig;
}

describe('runner device enforcement', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
  });

  it('executeJob throws when this machine is not in the devices allowlist', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ devices: ['yosemite-s0', 'mac-mini'] });
    await expect(executeJob(config)).rejects.toThrow(/restricted to device\(s\)/);
  });

  it('executeJobDetached returns a skipped meta when this machine is not allowed', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ devices: ['yosemite-s0'] });
    const meta = await executeJobDetached(config);
    expect(meta.status).toBe('failed');
    expect(meta.runId).toBe('skipped');
    expect(meta.exitCode).toBe(1);
  });

  it('executeJobDetached passes for unrestricted jobs (no device guard)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ devices: undefined });
    const meta = await executeJobDetached(config);
    // Unrestricted: the device guard does not reject, so runId is NOT 'skipped'.
    expect(meta.runId).not.toBe('skipped');
  });

  it('executeJobDetached passes when this machine is in the allowlist', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
    const config = baseConfig({ devices: ['yosemite-s0'] });
    const meta = await executeJobDetached(config);
    expect(meta.runId).not.toBe('skipped');
  });
});
