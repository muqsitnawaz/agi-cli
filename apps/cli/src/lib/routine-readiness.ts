/**
 * Activation readiness for a routine, composed from the target-aware execution
 * context ({@link resolveJobExecutionContext}) plus the harness/target checks a
 * caller can perform on this box (agent installed). This is the gate `add`,
 * `edit`, `doctor`, and `resume` all run before activating a routine: ready →
 * active, any proven blocker → saved paused with a stable code + repair command.
 *
 * Structural context readiness is synchronous for the scheduler. Interactive
 * add/edit/doctor/resume additionally call the live variant below, which probes
 * authentication and Codex's native workspace-trust record before activation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as TOML from 'smol-toml';
import type { JobConfig } from './routines.js';
import { resolveJobExecutionContext, resolveHostStrategy } from './routines.js';
import { evaluateRoutineReadiness, type RoutineReadinessResult, type PlacementMode } from './routine-context.js';
import { getVersionHomePath, resolveVersion } from './versions.js';
import { probeLocalFleetAuth } from './auth-health.js';

/**
 * Evaluate whether a routine is ready to activate on this box. `probeAgent`
 * defaults to "is a version of the routine's agent resolvable" via
 * {@link resolveVersion}; pass a stub in tests to exercise the availability path
 * without an installed harness.
 */
export function evaluateActivationReadiness(
  config: JobConfig,
  deps: { probeAgent?: (agent: string) => boolean } = {},
): RoutineReadinessResult {
  const strategy = resolveHostStrategy(config);
  const mode: PlacementMode = strategy;
  // Local placement inspects this box's filesystem; a remote/cloud target defers
  // existence (its filesystem is unreachable here) and checks portability only.
  const context = resolveJobExecutionContext(config, {
    mode,
    probe: mode === 'local' ? undefined : null,
  });

  const probeAgent = deps.probeAgent ?? ((agent: string) => resolveVersion(agent as never) !== undefined);
  return evaluateRoutineReadiness(
    context,
    {
      // Command routines have no agent to install; workflow routines dispatch
      // through `agents run` (claude under the hood) and are checked at run time.
      agentInstalled: config.agent && !config.workflow && !config.command
        ? () => probeAgent(config.agent!)
        : undefined,
    },
    { agent: config.agent },
  );
}

/** One-line human summary of a blocked readiness result, with its repair. */
export function formatReadinessBlocker(result: RoutineReadinessResult): string {
  if (result.ready || !result.readiness) return 'ready';
  const { code, message, repair } = result.readiness;
  return `${code}: ${message}${repair ? `\n  repair: ${repair}` : ''}`;
}

function codexWorkspaceTrusted(version: string, cwd: string): boolean {
  try {
    const configPath = path.join(getVersionHomePath('codex', version), '.codex', 'config.toml');
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, { trust_level?: string }> | undefined;
    return Object.entries(projects ?? {}).some(([root, project]) => {
      if (project.trust_level !== 'trusted') return false;
      const relative = path.relative(root, cwd);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  } catch {
    return false;
  }
}

/**
 * Interactive setup/repair readiness. Unlike the scheduler's deterministic
 * structural gate, this completes a real local auth request and reads Codex's
 * native trust record before add/edit/resume can activate the definition.
 */
export async function evaluateActivationReadinessLive(config: JobConfig): Promise<RoutineReadinessResult> {
  const structural = evaluateActivationReadiness(config);
  if (!structural.ready) return structural;

  const mode = resolveHostStrategy(config);
  if (mode !== 'local' || !config.agent || config.workflow || config.command) return structural;
  const version = resolveVersion(config.agent as never);
  if (!version) return structural;
  const context = resolveJobExecutionContext(config, { mode: 'local' });

  let authVerdict: { ok: boolean; reason?: string } | undefined;
  const rows = await probeLocalFleetAuth({ agents: [config.agent as never] });
  const row = rows.find((candidate) => candidate.version === version);
  if (row) {
    authVerdict = row.health.verdict === 'revoked'
      ? { ok: false, reason: row.health.verdict }
      : { ok: true };
  }

  return evaluateRoutineReadiness(context, {
    agentInstalled: () => true,
    ...(config.agent === 'codex' && context.absoluteCwd
      ? { codexTrusted: () => codexWorkspaceTrusted(version, context.absoluteCwd!) }
      : {}),
    ...(authVerdict ? { authOk: () => authVerdict! } : {}),
  }, { agent: config.agent });
}
