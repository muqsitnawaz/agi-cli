/**
 * `agents feed watch --json [--local]` — stream the single reconciled operator
 * projection (agents + attention + activity + scope + heartbeat) as versioned
 * NDJSON. AGI EXT's elected monitor consumes exactly this stream; the wire shape
 * is `apps/ext/src/monitor/protocol.ts`'s `SessionCliFactPayload`.
 *
 * It COMPOSES the existing session watcher and the feed store — it does not add
 * a second lifecycle detector or scheduler. `agents sessions watch --json` stays
 * compatible for session-only consumers; feed watch is the joined superset.
 */
import type { Command } from 'commander';
import { machineId } from '../lib/machine-id.js';
import { setHelpSections } from '../lib/help.js';
import { watchFleetFeed, watchLocalFeed, type FeedWatchEnvelope } from '../lib/feed/watch.js';

export function registerFeedWatchCommand(parent: Command): void {
  const command = parent.command('watch')
    .description('Stream the reconciled operator projection (agents + attention + activity) as NDJSON')
    .option('--json', 'Emit versioned NDJSON envelopes')
    .option('--local', 'Watch only this machine');

  setHelpSections(command, {
    examples: `
      # Subscribe to the joined agents + Needs-You projection for a UI consumer
      agents feed watch --json

      # Subscribe only to this machine (the per-peer worker the coordinator dials)
      agents feed watch --json --local
    `,
    notes: `
      - Each line is one versioned reset, agent.upsert, attention.upsert, attention.remove, activity.append, scope, or heartbeat envelope.
      - rowKey is opaque. Order changes by streamId + sequence; forwarded peer envelopes keep the peer's own stream identity.
      - An unavailable scope retains its last rows until that scope reconnects.
      - This is the joined superset of \`agents sessions watch --json\`; session-only consumers may keep using that command.
    `,
  });

  command.action(async (_options: { local?: boolean; json?: boolean }, invoked: Command) => {
    const options = invoked.optsWithGlobals() as { local?: boolean; json?: boolean };
    if (!options.json) invoked.error('error: required option \'--json\' not specified');
    const controller = new AbortController();
    const stop = () => controller.abort();
    const stopOnClosedConsumer = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') controller.abort();
      else {
        process.exitCode = 1;
        controller.abort(error);
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdout.on('error', stopOnClosedConsumer);
    try {
      const emit = (event: FeedWatchEnvelope) => process.stdout.write(`${JSON.stringify(event)}\n`);
      if (options.local) await watchLocalFeed({ scope: machineId(), signal: controller.signal, emit });
      else await watchFleetFeed({ signal: controller.signal, emit });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.stdout.off('error', stopOnClosedConsumer);
    }
  });
}
