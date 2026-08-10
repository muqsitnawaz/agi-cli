import type { Command } from 'commander';
import { machineId } from '../lib/machine-id.js';
import { setHelpSections } from '../lib/help.js';
import { watchLocalSessions } from '../lib/session/watch.js';

export function registerSessionsWatchCommand(parent: Command): void {
  const command = parent.command('watch')
    .description('Stream canonical live and recoverable session row changes as NDJSON')
    .requiredOption('--json', 'Emit versioned NDJSON envelopes')
    .option('--local', 'Watch only this machine');

  setHelpSections(command, {
    examples: `
      # Subscribe to session changes for a long-lived UI consumer
      agents sessions watch --json

      # Subscribe only to this machine
      agents sessions watch --json --local
    `,
    notes: `
      - Each line is one versioned reset, upsert, remove, scope, or heartbeat envelope.
      - rowKey is opaque. Order changes by streamId + sequence.
      - An unavailable scope retains its last rows until that scope reconnects.
    `,
  });

  command.action(async () => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await watchLocalSessions({
        scope: machineId(), signal: controller.signal,
        emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  });
}
