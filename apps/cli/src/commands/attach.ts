/**
 * `agents sessions attach <id>` — bring a backgrounded (or parked) agent session
 * back to the foreground: stop its headless continuation, then resume it
 * interactively in this terminal. The resume is version-pinned native resume
 * (claude/codex) or a `/continue` replay (others) — the same session, full
 * history, the exact inverse of `agents sessions detach`.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { discoverSessions } from '../lib/session/discover.js';
import { resumeSessionInPlace } from './sessions.js';
import { readDetachRecord, clearDetachRecord, isHeadlessAlive } from '../lib/session/detached.js';
import { sessionOwnerDevice } from '../lib/session/resume-owner.js';
import { runOnPeer } from '../lib/session/remote-list.js';

export function registerAttachCommand(program: Command): void {
  program
    .command('attach')
    .argument('<id>', 'Short or full id of the backgrounded/parked session to resume interactively')
    .description('Bring a backgrounded agent to the foreground — resume it interactively here')
    .action(async (id: string) => {
      await attachAction(id);
    });
}

export async function attachAction(id: string): Promise<void> {
  const q = id.toLowerCase();
  // Rich meta carries the pinned version + origin cwd the resume needs.
  const metas = await discoverSessions({ all: true, since: '90d', limit: 2000 });
  const meta = metas.find((m) => m.id === id) ?? metas.find((m) => m.id.toLowerCase().startsWith(q));
  if (!meta) {
    console.error(chalk.red(`No session matching "${id}".`));
    console.error(chalk.gray('  See your sessions: agents sessions'));
    process.exitCode = 1;
    return;
  }

  // A session that ran on another device attaches THERE — as an attach, not a
  // bare resume. Both halves of this command are machine-local: the detach
  // record below lives on the owner's disk, and so does the headless process it
  // stops. Hopping with `agents resume` instead would skip that stop entirely
  // and leave two processes on one transcript, which is the precise thing the
  // next block exists to prevent (RUSH-2022).
  const owner = sessionOwnerDevice(meta);
  if (owner) {
    console.log(chalk.gray(`Session ${meta.shortId} belongs to ${owner} — attaching there over SSH…`));
    const rc = await runOnPeer(['sessions', 'attach', meta.id], owner, { tty: true });
    if (rc === 'no-target') {
      console.error(chalk.red(`${owner} isn't a reachable device right now.`));
      console.error(chalk.gray(`  Register/wake it (agents devices), or run there: agents ssh ${owner}`));
      process.exitCode = 1;
    }
    return;
  }

  // If it's backgrounded, stop the headless continuation first so two processes
  // don't resume the same transcript at once.
  const rec = readDetachRecord(meta.id);
  if (rec) {
    if (isHeadlessAlive(rec)) {
      try {
        process.kill(rec.headlessPid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    clearDetachRecord(meta.id);
  }

  console.log(chalk.gray(`Attaching ${meta.agent} ${meta.id.slice(0, 8)} — resuming interactively…`));
  await resumeSessionInPlace(meta);
}
