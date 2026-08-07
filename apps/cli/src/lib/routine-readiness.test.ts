import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import type { JobConfig } from './routines.js';
import { evaluateActivationReadiness } from './routine-readiness.js';

function job(over: Partial<JobConfig>): JobConfig {
  return {
    name: 'r', schedule: '0 3 * * *',
    mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'hi',
    ...over,
  } as JobConfig;
}

describe('evaluateActivationReadiness', () => {
  it('a command routine with no context is ready (home fallback)', () => {
    const r = evaluateActivationReadiness(job({ command: 'echo hi', prompt: '' }));
    expect(r.ready).toBe(true);
  });

  it('an agent routine with no project/cwd is blocked (execution_context_missing)', () => {
    const r = evaluateActivationReadiness(job({ agent: 'claude' }), { probeAgent: () => true });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('execution_context_missing');
  });

  it('an agent routine with a valid home cwd and an installed agent is ready', () => {
    const r = evaluateActivationReadiness(job({ agent: 'claude', cwd: '~' }), { probeAgent: () => true });
    expect(r.ready).toBe(true);
  });

  it('an agent routine whose agent is not installed is agent_unavailable', () => {
    const r = evaluateActivationReadiness(job({ agent: 'claude', cwd: '~' }), { probeAgent: () => false });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('agent_unavailable');
  });

  it('an agent routine pointing at a missing directory is blocked (cwd_missing)', () => {
    const missing = path.join(os.homedir(), 'definitely-not-here-routine-xyz-42');
    const r = evaluateActivationReadiness(job({ agent: 'claude', cwd: missing }), { probeAgent: () => true });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('cwd_missing');
  });
});
