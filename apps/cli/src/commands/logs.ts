/**
 * `agents logs` — thin alias of `agents events`, plus a content redirect.
 *
 * Timeline / ops / audit / stats / rotate all live on the events engine:
 *   agents logs              ≡ agents events
 *   agents logs audit        ≡ agents events --include ops
 *   agents logs stats        ≡ agents events stats
 *   agents logs rotate       ≡ agents events rotate
 *
 * Per-run content (session transcript / host-task stdout) is NOT this product:
 *   agents sessions <id>
 *   agents hosts logs <id>
 *
 * A bare `agents logs <id>` prints a redirect to those commands.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  addEventsReadOptions,
  runEventsCommand,
  type EventsOptions,
} from './events.js';
import { stats, getLogsPath, rotate } from '../lib/events.js';

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseSince(s: string): Date {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs: Record<string, number> = {
      s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
    };
    return new Date(Date.now() - n * unitMs[m[2]]);
  }
  const ms = Date.parse(s);
  if (isNaN(ms)) throw new Error(`Invalid --since value: ${s} (use e.g. 2h, 7d, or an ISO date)`);
  return new Date(ms);
}

function levelColor(level: string): string {
  if (level === 'audit') return chalk.magenta(level);
  if (level === 'warn') return chalk.yellow(level);
  if (level === 'debug') return chalk.gray(level);
  return chalk.blue(level);
}

/** Register the top-level `agents logs` command as an events alias. */
export function registerLogsCommand(program: Command): void {
  const logsCmd = addEventsReadOptions(
    program
      .command('logs [id]')
      .description('Alias of `agents events`. Pass an id to see the content redirect.'),
    true,
  )
    .addHelpText('after', `
Examples:
  agents logs                            Same as: agents events
  agents logs --exclude commands
  agents logs audit                      Same as: agents events --include ops
  agents logs stats
  agents logs rotate

  # Session / host-task content is not this command:
  agents sessions <id>
  agents hosts logs <task-id>
`)
    .action(async (id: string | undefined, opts: EventsOptions & { session?: string }, command: Command) => {
      const merged = { ...command.optsWithGlobals(), ...opts } as EventsOptions & { session?: string };
      const directId = id ?? merged.session;
      if (directId) {
        console.error(chalk.yellow(
          `agents logs no longer shows run content for "${directId}".\n` +
          `  Session transcript:  agents sessions ${directId}\n` +
          `  Host-task stdout:    agents hosts logs ${directId}\n` +
          `  Event timeline:      agents events --session ${directId}`,
        ));
        process.exitCode = 2;
        return;
      }
      return runEventsCommand(merged);
    });

  addEventsReadOptions(
    logsCmd
      .command('audit')
      .description('Alias of `agents events --include ops`'),
    false,
  )
    .action((_options: EventsOptions, command: Command) => {
      const opts = command.optsWithGlobals() as EventsOptions;
      if (!opts.include && !opts.exclude && !opts.audit) opts.include = 'ops';
      return runEventsCommand(opts, true);
    });

  logsCmd
    .command('stats')
    .description('Alias of `agents events stats`')
    .option('--since <time>', 'Window size (e.g. 7d, 30d; default 7d)')
    .option('--json', 'Output stats as JSON')
    .action(async (opts: { since?: string; json?: boolean }) => {
      let days = 7;
      if (opts.since) {
        try {
          const d = parseSince(opts.since);
          days = Math.max(1, Math.ceil((Date.now() - d.getTime()) / 86_400_000));
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(2);
        }
      }
      const s = stats({ days });
      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log(chalk.bold(`Event statistics (last ${days} day${days === 1 ? '' : 's'})\n`));
      console.log(`  Total events:  ${s.totalEvents}`);
      console.log(`  Log files:     ${s.fileCount} (${humanBytes(s.totalBytes)})`);
      console.log(`  Log path:      ${chalk.gray(getLogsPath())}`);
      if (Object.keys(s.byLevel).length) {
        console.log(chalk.bold('\n  By level:'));
        for (const [k, v] of Object.entries(s.byLevel).sort((a, b) => b[1] - a[1])) {
          console.log(`    ${levelColor(k).padEnd(20)} ${v}`);
        }
      }
      if (Object.keys(s.byEvent).length) {
        console.log(chalk.bold('\n  By event (top 15):'));
        for (const [k, v] of Object.entries(s.byEvent).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
          console.log(`    ${chalk.cyan(k).padEnd(30)} ${v}`);
        }
      }
      if (Object.keys(s.byModule).length) {
        console.log(chalk.bold('\n  By module:'));
        for (const [k, v] of Object.entries(s.byModule).sort((a, b) => b[1] - a[1])) {
          console.log(`    ${k.padEnd(20)} ${v}`);
        }
      }
      console.log();
    });

  logsCmd
    .command('rotate')
    .description('Alias of `agents events rotate`')
    .option('--days <n>', 'Retention period in days (default 7)', '7')
    .option('--max-mb <n>', 'Total event storage ceiling in MiB (default 50)', '50')
    .action((opts: { days?: string; maxMb?: string }) => {
      const days = Math.max(1, parseInt(opts.days ?? '7', 10) || 7);
      const maxMb = Math.max(1, parseInt(opts.maxMb ?? '50', 10) || 50);
      const result = rotate(days, maxMb * 1024 * 1024);
      const removed = result.removedByAge + result.removedBySize;
      if (removed > 0) {
        console.log(
          `Removed ${removed} event file${removed === 1 ? '' : 's'} ` +
          `(${result.removedByAge} by age, ${result.removedBySize} by size); ` +
          `reclaimed ${humanBytes(result.bytesReclaimed)}.`,
        );
      } else {
        console.log(chalk.gray(`No event files removed (retention ${days} days, ceiling ${maxMb} MiB).`));
      }
    });
}
