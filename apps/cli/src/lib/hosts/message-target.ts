/**
 * Resolve `agents message <target>` against detached `--device`/`--host`
 * dispatches (the records `agents hosts ps` reads), so a message can reach — or
 * fail loud with a real recovery path for — an `agents run --device --no-follow`
 * run that has no LOCAL live session and so is invisible to the active-session
 * resolver (RUSH-2366, third defect). Pure (no I/O) so it is unit-testable; the
 * caller supplies the (already status-reconciled) HostTask.
 */
import type { HostTask } from './tasks.js';

export type HostDispatchDelivery =
  | {
      // The dispatch is running and has a resumable remote session id, so the
      // message can be forwarded over ssh to its mailbox ON the host.
      kind: 'forward';
      host: string;
      target: string;
      sessionId: string;
      identityFile?: string;
      label: string;
    }
  | {
      // The dispatch matched a host record but cannot be steered from here; the
      // reason names the real way to observe or end it.
      kind: 'unreachable';
      reason: string;
    };

/**
 * Decide how (if at all) a message reaches a matched host dispatch. Three cases:
 *   - terminal              -> unreachable, point at `agents hosts logs`.
 *   - running, no sessionId -> unreachable (a --no-follow run captures its id
 *                              only after its first turn), point at logs / stop.
 *   - running, sessionId    -> forward over ssh to the host's mailbox.
 */
export function decideHostDispatchDelivery(task: HostTask): HostDispatchDelivery {
  const label = task.name ?? task.id;
  if (task.status !== 'running') {
    const exit = task.exitCode != null ? ` (exit ${task.exitCode})` : '';
    return {
      kind: 'unreachable',
      reason:
        `Dispatch '${label}' on ${task.host} has already finished — status ${task.status}${exit}. ` +
        `There is no running agent to message. Read its output with \`agents hosts logs ${label}\`, ` +
        `or start a fresh run with \`agents run --device ${task.host} ...\`.`,
    };
  }
  if (!task.sessionId) {
    return {
      kind: 'unreachable',
      reason:
        `Dispatch '${label}' is running on ${task.host} but has not registered a resumable session id yet ` +
        `(a --no-follow run captures it only after its first turn), so it has no mailbox reachable from here. ` +
        `Watch it with \`agents hosts logs ${label}\`, or end it with \`agents hosts stop ${label}\`.`,
    };
  }
  return {
    kind: 'forward',
    host: task.host,
    target: task.target,
    sessionId: task.sessionId,
    identityFile: task.identityFile,
    label,
  };
}
