/**
 * Shared host-task log viewer — the show-or-follow core behind both
 * `agents hosts logs <id>` and the top-level `agents logs <id>`.
 *
 * A running task with follow re-enters the offset-tail (`followHostTask`);
 * otherwise the captured local mirror (`localLogPath`) is printed first. When
 * no local mirror exists (detached `--no-follow` runs that were never followed),
 * we do an on-demand one-shot fetch from the remote log so that
 * `agents hosts logs <id>` is always useful, even for detached dispatches.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { loadTask, localLogPath, updateTask } from './tasks.js';
import { followHostTask, fetchRemoteLog } from './progress.js';

export interface HostLogResult {
  /** False when no host task with this id exists (caller may fall through to sessions). */
  found: boolean;
  /** Process exit code to adopt when the task was shown/followed. */
  exitCode?: number;
}

/** Show (or follow, when running) a dispatched host task's combined-stdout log. */
export async function showHostTaskLog(id: string, follow: boolean): Promise<HostLogResult> {
  const task = loadTask(id);
  if (!task) return { found: false };

  // Follow a running task: stream progress until completion, then persist status so
  // subsequent `agents hosts ps` shows the terminal state rather than 'running'.
  if (follow && task.status === 'running') {
    const code = await followHostTask(task.target, {
      remoteLog: task.remoteLog,
      remoteExit: task.remoteExit,
      taskId: id,
      echo: true,
    });
    updateTask(id, {
      status: code === 0 ? 'completed' : code === -1 ? 'unknown' : 'failed',
      exitCode: code === -1 ? undefined : code,
      finishedAt: new Date().toISOString(),
    });
    return { found: true, exitCode: code === -1 ? 1 : code };
  }

  // Local mirror (written by followHostTask) is the fast path.
  const localLog = localLogPath(id);
  if (fs.existsSync(localLog)) {
    process.stdout.write(fs.readFileSync(localLog, 'utf-8'));
    return { found: true, exitCode: task.exitCode ?? 0 };
  }

  // No local mirror — fetch from the remote on demand. This is the primary fix for
  // detached (--no-follow) runs: the log was never mirrored locally, but it exists
  // on the host and is accessible over SSH.
  process.stderr.write(chalk.gray(`[hosts] fetching log from ${task.host}…\n`));
  const remote = fetchRemoteLog(task.target, task.remoteLog);
  if (remote !== null) {
    process.stdout.write(remote);
    if (task.status === 'running') {
      // Do NOT cache a running task's log: it's a partial snapshot, and caching
      // it would make the mirror-exists fast path above serve stale bytes on the
      // next call (and a later `-f` re-append onto them). Re-fetch fresh instead.
      process.stderr.write(chalk.gray(`Task still running. Follow live: agents hosts logs ${id} -f\n`));
    } else {
      // Terminal task: cache the complete log so subsequent calls skip the SSH round-trip.
      try {
        fs.mkdirSync(path.dirname(localLog), { recursive: true });
        fs.writeFileSync(localLog, remote);
      } catch { /* best-effort */ }
    }
  } else {
    console.log(chalk.gray('(log unavailable — host may be offline or run did not capture output)'));
  }
  return { found: true, exitCode: task.exitCode ?? 0 };
}
