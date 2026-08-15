import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { listTickets } from '../lib/tickets/list.js';

export function registerTicketsCommand(program: Command): void {
  const tickets = program
    .command('tickets')
    .description('Read work items from the trackers linked to this workspace.');

  setHelpSections(tickets, {
    examples: `
      agents tickets list --json
      agents tickets list --github-assigned-only --json
    `,
    notes: `
      The response reports each source's availability explicitly. A failed tracker
      never makes another tracker's rows disappear.
    `,
  });

  tickets
    .command('list')
    .description('List workspace tickets from Linear and GitHub.')
    .option('--cwd <path>', 'Workspace used to resolve tracker context')
    .option('--no-linear', 'Exclude Linear tickets')
    .option('--no-github', 'Exclude GitHub issues')
    .option('--github-assigned-only', 'Only include GitHub issues assigned to the current user')
    .option('--json', 'Output machine-readable tickets, cycle metadata, and source availability')
    .action(async (options: {
      cwd?: string;
      linear: boolean;
      github: boolean;
      githubAssignedOnly?: boolean;
      json?: boolean;
    }) => {
      const result = await listTickets({
        cwd: options.cwd ?? process.cwd(),
        linear: options.linear,
        github: options.github,
        githubAssignedOnly: options.githubAssignedOnly === true,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`${result.tickets.length} ticket${result.tickets.length === 1 ? '' : 's'}`);
      for (const source of ['linear', 'github'] as const) {
        const status = result.sources[source];
        if (!status.available && status.error) console.error(`${source}: ${status.error}`);
      }
    });
}
