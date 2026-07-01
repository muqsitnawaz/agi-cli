/**
 * Follow a dispatched host run by offset-tailing its remote log.
 *
 * The run writes combined output to a log file on the host and its exit code to
 * a sibling `.exit` file. We poll `tail -c +<offset>` (durable, offset-tracked —
 * a dropped connection resumes from the saved offset) and finish when `.exit`
 * appears. Rich transcript-parser rendering is a fast-follow.
 *
 * Efficiency: each cycle is a SINGLE ssh round-trip that returns the new log
 * bytes, a per-task sentinel, then the exit-file contents — half the process +
 * handshake cost of the old tail-then-cat pair. It rides the default control
 * socket (multiplex on) that the launch opened, and eases the poll interval off
 * toward `maxPollMs` while the job is idle, so a quiet long-running follow no
 * longer spawns thousands of ssh processes per hour on the laptop.
 */

import * as fs from 'fs';
import { sshExec } from '../ssh-exec.js';
import { localLogPath, updateTask, type HostTask } from './tasks.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FollowOptions {
  remoteLog: string;
  remoteExit: string;
  /** Mirror remote output into this task's local log too. */
  taskId: string;
  /** Print streamed output to stdout. */
  echo?: boolean;
  /** Overall wall-clock cap; returns -1 on timeout. */
  timeoutMs?: number;
  /** Fast poll interval while output is flowing (default 1500ms). */
  pollMs?: number;
  /** Idle-backoff ceiling (default 4× the fast interval, min 4000ms). */
  maxPollMs?: number;
}

/**
 * Build the per-task sentinel that separates the log tail from the exit-file
 * contents in one combined fetch. The task id (8 hex chars) makes collision with
 * the agent's own output effectively impossible; callers still split on the LAST
 * occurrence so a token echoed into the log can never be mistaken for the real
 * trailing marker.
 */
export function exitMarker(taskId: string): string {
  return `\n@@AGENTS_HOST_EXIT_${taskId}@@\n`;
}

/**
 * Split a combined fetch (`<log bytes><marker><exit>`) back into its parts.
 * Splits on the LAST marker occurrence, so even if the agent's own output
 * happened to echo the token, the real trailing sentinel still wins. Returns
 * null when the marker is absent (a transient fetch miss — the remote shell
 * never ran our printf), telling the caller to retry without advancing.
 */
export function splitProgressOutput(stdout: string, taskId: string): { logChunk: string; exit: string } | null {
  const marker = exitMarker(taskId);
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) return null;
  return { logChunk: stdout.slice(0, idx), exit: stdout.slice(idx + marker.length) };
}

/**
 * One round-trip: new log bytes since `offset`, the sentinel, then the exit
 * file. Returns null on a transient fetch miss (ssh error / marker absent) so
 * the caller simply retries next cycle without advancing the offset.
 *
 * `remoteLog`/`remoteExit` are $HOME-prefixed paths with safe (hex) basenames —
 * intentionally unquoted so the remote shell expands $HOME.
 */
export function fetchProgress(
  target: string,
  opts: { remoteLog: string; remoteExit: string; taskId: string; offset: number },
): { logChunk: string; exit: string } | null {
  // Derive the printf format from the SAME exitMarker the parser splits on, so
  // the emitted sentinel and the one we look for can never desync. The marker's
  // only escape-sensitive bytes are its newlines (→ `\n`); it carries no `%`,
  // single-quote, or other printf/shell-special chars (task id is hex).
  const printfArg = exitMarker(opts.taskId).replace(/\n/g, '\\n');
  const remote =
    `tail -c +${opts.offset + 1} ${opts.remoteLog} 2>/dev/null; ` +
    `printf '${printfArg}'; ` +
    `cat ${opts.remoteExit} 2>/dev/null`;
  const res = sshExec(target, remote, { timeoutMs: 20000 });
  return splitProgressOutput(res.stdout, opts.taskId);
}

/** One-shot full fetch of a remote log file. Returns null on ssh error or if the file is absent. */
export function fetchRemoteLog(target: string, remoteLog: string): string | null {
  const r = sshExec(target, `cat ${remoteLog} 2>/dev/null`, { timeoutMs: 20000, multiplex: true });
  if (r.code !== 0) return null;
  return r.stdout;
}

/**
 * Check if a remote task's exit file has appeared; returns the exit code or null
 * when the file is absent (run still in progress or not yet flushed).
 */
export function checkRemoteExit(target: string, remoteExit: string): number | null {
  const r = sshExec(target, `cat ${remoteExit} 2>/dev/null`, { timeoutMs: 10000, multiplex: true });
  const s = r.stdout.trim();
  if (!s) return null;
  const code = parseInt(s, 10);
  return Number.isFinite(code) ? code : 0;
}

/**
 * For each task still recorded as 'running', probe the remote exit file and
 * update the local record to its terminal status. Mutates the task store on
 * disk. Called by `agents hosts ps` so the table reflects reality.
 */
export function refreshRunningTasks(tasks: HostTask[]): void {
  for (const t of tasks) {
    if (t.status !== 'running') continue;
    const code = checkRemoteExit(t.target, t.remoteExit);
    if (code !== null) {
      updateTask(t.id, {
        status: code === 0 ? 'completed' : 'failed',
        exitCode: code,
        finishedAt: new Date().toISOString(),
      });
    }
  }
}

/** Tail the remote log to stdout until the run finishes; return its exit code. */
export async function followHostTask(target: string, opts: FollowOptions): Promise<number> {
  const fastMs = opts.pollMs ?? 1500;
  const maxMs = Math.max(opts.maxPollMs ?? fastMs * 4, 4000);
  const deadline = Date.now() + (opts.timeoutMs ?? 3600_000);
  const local = localLogPath(opts.taskId);
  let offset = 0;
  let waitMs = fastMs;

  const flush = (logChunk: string): boolean => {
    if (!logChunk) return false;
    if (opts.echo) process.stdout.write(logChunk);
    try { fs.appendFileSync(local, logChunk); } catch { /* best-effort */ }
    offset += Buffer.byteLength(logChunk, 'utf8');
    return true;
  };

  for (;;) {
    const r = fetchProgress(target, { remoteLog: opts.remoteLog, remoteExit: opts.remoteExit, taskId: opts.taskId, offset });
    const gotOutput = r ? flush(r.logChunk) : false;

    if (r && r.exit.trim() !== '') {
      // Finished — one final fetch catches bytes written between our tail and
      // the exit file appearing.
      const tail = fetchProgress(target, { remoteLog: opts.remoteLog, remoteExit: opts.remoteExit, taskId: opts.taskId, offset });
      if (tail) flush(tail.logChunk);
      const code = parseInt(r.exit.trim(), 10);
      return Number.isFinite(code) ? code : 0;
    }
    if (Date.now() > deadline) {
      process.stderr.write('\n[hosts] follow timed out; the run continues on the host. Reattach with: agents hosts logs ' + opts.taskId + ' -f\n');
      return -1;
    }

    // Fast while output flows; ease toward maxMs when idle so a quiet job isn't
    // polled needlessly. New output snaps the cadence back to fast.
    waitMs = gotOutput ? fastMs : Math.min(maxMs, Math.round(waitMs * 1.5));
    await sleep(waitMs);
  }
}
