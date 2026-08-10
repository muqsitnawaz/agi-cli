import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { listTickets } from '../lib/tickets/list.js';

export function registerTicketsCommand(program: Command): void {
  const tickets = program.command('tickets').description('Read work items from linked issue trackers.');
  setHelpSections(tickets, { examples: `
      agents tickets list --json
      agents tickets list --github-assigned-only --json
  ` });
  tickets.command('list')
    .description('List workspace tickets from available trackers.')
    .option('--cwd <path>', 'Workspace used to resolve tracker context', process.cwd())
    .option('--no-linear', 'Exclude Linear tickets')
    .option('--no-github', 'Exclude GitHub issues')
    .option('--github-assigned-only', 'Only include GitHub issues assigned to the current user')
    .option('--json', 'Output machine-readable tickets and source availability')
    .action(async (opts: { cwd: string; linear: boolean; github: boolean; githubAssignedOnly?: boolean; json?: boolean }) => {
      const result = await listTickets({ cwd: opts.cwd, linear: opts.linear, github: opts.github, assignedOnly: opts.githubAssignedOnly === true });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.tickets.length} ticket${result.tickets.length === 1 ? '' : 's'}`);
    });
}
