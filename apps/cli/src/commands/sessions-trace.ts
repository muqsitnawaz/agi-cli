/**
 * `agents sessions trace <selector>` (alias: `agents trace <selector>`) — render
 * one session as a derived trajectory.
 *
 * One model (`buildTrajectory`), three renderings, audience auto-selected: a
 * person at a TTY gets the self-contained HTML opened in a browser; a piped or
 * headless caller (an agent) gets the compact text trajectory; `--json` emits the
 * versioned envelope the AGI EXT Fleet panel and triaging agents consume. Explicit
 * `--html/--text/--json` always win.
 *
 * Single-session only in this release. More than one resolved selector fails loud
 * — compare (several sessions) and lineage (a parent + its team) land in a
 * follow-up PR — never a silent no-op.
 */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { openUrl } from '../lib/open-url.js';
import { knownSecretValuesFromEnv } from '../lib/redact.js';
import { getCacheDir } from '../lib/state.js';
import { discoverSessions } from '../lib/session/discover.js';
import { parseSession } from '../lib/session/parse.js';
import { buildTrajectory } from '../lib/session/trajectory.js';
import { renderTrajectoryHtml } from '../lib/session/trajectory-html.js';
import { renderTrajectoryText } from '../lib/session/trajectory-text.js';
import type { SessionTrajectory } from '../lib/session/trajectory.js';
import { parseAgentFilter } from './sessions.js';
import { selectSessions } from './sessions-export.js';

/** Versioned envelope emitted by `--json` — the stable contract for consumers. */
export const SESSIONS_TRACE_SCHEMA_VERSION = 1;

/** The `--json` envelope: the versioned contract for the ext / triaging agents. */
export interface SessionsTraceEnvelope {
  schemaVersion: typeof SESSIONS_TRACE_SCHEMA_VERSION;
  kind: 'sessions-trace';
  layout: 'single';
  sessions: SessionTrajectory[];
}

/** Build the versioned `--json` envelope for one or more trajectories. */
export function buildTraceEnvelope(models: SessionTrajectory[]): SessionsTraceEnvelope {
  return {
    schemaVersion: SESSIONS_TRACE_SCHEMA_VERSION,
    kind: 'sessions-trace',
    layout: 'single',
    sessions: models,
  };
}

interface TraceOptions {
  html?: boolean;
  text?: boolean;
  json?: boolean;
  output?: string;
  open?: boolean; // --no-open sets this false
  errorsOnly?: boolean;
  redact?: boolean; // --no-redact sets this false
  all?: boolean;
  since?: string;
  limit?: string;
  agent?: string;
}

export type RenderFormat = 'html' | 'text' | 'json';

/**
 * Pick the rendering by audience: explicit `--html/--text/--json` win; otherwise
 * a person at a TTY gets the visual HTML and a piped/headless caller (an agent)
 * gets the compact text trajectory.
 */
export function chooseFormat(options: TraceOptions, isTTY: boolean): RenderFormat {
  if (options.json) return 'json';
  if (options.html) return 'html';
  if (options.text) return 'text';
  return isTTY ? 'html' : 'text';
}

/** Attach the trace behaviour to a command node (canonical or top-level alias). */
export function configureTraceCommand(cmd: Command): Command {
  cmd
    .description('Visualize a session as a trajectory — a tool-call timeline you can read at a glance. Opens a visual for a person; prints a compact trajectory for an agent.')
    .option('--html', 'Force the HTML rendering (opens in a browser)')
    .option('--text', 'Force the compact text trajectory')
    .option('--json', 'Emit the versioned sessions-trace JSON envelope')
    .option('-o, --output <path>', 'Write the rendering to a path instead of opening/printing')
    .option('--no-open', 'Do not open the HTML; print its path instead')
    .option('--errors-only', 'Collapse the text trajectory to error steps and their neighbours')
    .option('--no-redact', 'Local-only: skip secret redaction of derived labels (never for a shared file)')
    .option('--all', 'Search every directory and all time, not just this project')
    .option('--since <time>', 'Only sessions newer than this (7d, 4w, an ISO date)')
    .option('--limit <n>', 'Max sessions to scan when resolving the selector (default 100)')
    .option('-a, --agent <agent>', 'Filter by agent type (e.g. claude, codex)');

  setHelpSections(cmd, {
    examples: `# Open one session's trajectory in a browser (a person at a terminal)
agents sessions trace a1b2c3d4

# The compact text trajectory an agent reads in-context
agents sessions trace a1b2c3d4 --text

# Just the failures and their neighbours — for a triaging agent
agents sessions trace a1b2c3d4 --text --errors-only

# The stable JSON envelope for the AGI EXT Fleet panel or a tool
agents sessions trace a1b2c3d4 --json

# Write the self-contained HTML to a file without opening it
agents sessions trace a1b2c3d4 --html -o trace.html --no-open`,
    notes: `Audience auto-select: with no --html/--text/--json, HTML opens on a TTY (a person) and
the compact text trajectory prints when piped or headless (an agent). The HTML is self-contained
(no CDN, no external asset) and redacted by default, as safe to share as an 'agents sessions share' page.

--json emits { schemaVersion, kind: 'sessions-trace', layout: 'single', sessions: [SessionTrajectory] } —
the contract consumers read so nothing re-parses a transcript.

This release renders ONE session. Passing several selectors is an error: compare (several sessions)
and lineage (a parent + its team) land in a follow-up PR.`,
  });

  cmd.action(async (selectors: string[], _options: TraceOptions, command: Command) => {
    // Merge parent globals: under `agents sessions trace`, the `sessions` command
    // owns `--json`/`--no-redact`/`--all`/`--agent`/`--since` and captures them, so
    // read the merged view (as `render`/`insights` do) — the top-level `agents
    // trace` alias has no such parent and its own options fill the same fields.
    const options = command.optsWithGlobals() as TraceOptions;
    const limit = Math.max(1, Number.parseInt(options.limit || '100', 10) || 100);
    const agent = parseAgentFilter(options.agent).agent;
    const pool = await discoverSessions({
      // Default to every directory so an id from any project resolves, matching
      // `agents sessions render` (sessions-render.ts:126).
      all: options.all !== false,
      since: options.since,
      limit,
      agent: agent ?? undefined,
    });
    const sessions = selectSessions(pool, selectors);

    if (sessions.length === 0) {
      process.stderr.write(chalk.yellow('No sessions matched the selection.\n'));
      process.exitCode = 1;
      return;
    }
    if (sessions.length > 1) {
      // Fail loud — never silently trace only the first of several.
      throw new Error(
        `\`agents sessions trace\` renders one session in this release; ${sessions.length} matched. ` +
        'Compare (several sessions) and lineage (a parent + its team) land in a follow-up PR — pass a single selector.',
      );
    }

    const session = sessions[0];
    const redact = options.redact !== false;
    const knownSecrets = redact ? knownSecretValuesFromEnv() : undefined;
    const events = parseSession(session.filePath, session.agent);
    const model = buildTrajectory(events, session, { redact, knownSecrets });

    const format = chooseFormat(options, Boolean(process.stdout.isTTY));

    if (format === 'json') {
      const out = JSON.stringify(buildTraceEnvelope([model]), null, 2) + '\n';
      if (options.output) {
        fs.writeFileSync(options.output, out, { mode: 0o600 });
        process.stderr.write(chalk.green(`Wrote trajectory JSON to ${options.output}\n`));
      } else {
        process.stdout.write(out);
      }
      return;
    }

    if (format === 'text') {
      const out = renderTrajectoryText(model, { errorsOnly: options.errorsOnly === true });
      if (options.output) {
        fs.writeFileSync(options.output, out, { mode: 0o600 });
        process.stderr.write(chalk.green(`Wrote text trajectory to ${options.output}\n`));
      } else {
        process.stdout.write(out);
      }
      return;
    }

    // HTML.
    const html = renderTrajectoryHtml(model);
    if (options.output) {
      fs.writeFileSync(options.output, html, { mode: 0o600 });
      process.stdout.write(`${path.resolve(options.output)}\n`);
      return;
    }
    const dir = path.join(getCacheDir(), 'traces');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${session.shortId || session.id}-${Date.now()}.html`);
    fs.writeFileSync(file, html, { mode: 0o600 });
    if (options.open === false) {
      process.stdout.write(`${file}\n`);
    } else {
      openUrl(file);
      process.stderr.write(chalk.green(`Opened trajectory for ${session.shortId || session.id}: ${file}\n`));
    }
  });

  return cmd;
}

/** Canonical `agents sessions trace <selectors...>`. */
export function registerSessionsTraceCommand(sessionsCmd: Command): void {
  configureTraceCommand(sessionsCmd.command('trace <selectors...>'));
}

/** Top-level alias `agents trace <selectors...>` (mirrors `agents insights`). */
export function registerTraceCommand(program: Command): void {
  configureTraceCommand(program.command('trace <selectors...>'));
}
