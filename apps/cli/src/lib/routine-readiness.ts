/**
 * Activation readiness for a routine, composed from the target-aware execution
 * context ({@link resolveJobExecutionContext}) plus the harness/target checks a
 * caller can perform on this box (agent installed). This is the gate `add`,
 * `edit`, `doctor`, and `resume` all run before activating a routine: ready →
 * active, any proven blocker → saved paused with a stable code + repair command.
 *
 * The heavy live checks the plan defers to `doctor --fix` (a live auth smoke, a
 * Codex workspace-trust probe) are NOT run here — they need network / a spawned
 * process and belong to the interactive repair surface. Structural context
 * readiness and agent availability are the deterministic checks every save runs.
 */

import type { JobConfig } from './routines.js';
import { resolveJobExecutionContext, resolveHostStrategy } from './routines.js';
import { evaluateRoutineReadiness, type RoutineReadinessResult, type PlacementMode } from './routine-context.js';
import { resolveVersion } from './versions.js';

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
