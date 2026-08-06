/**
 * `agents sessions resume` — multi-select sessions and fan each one out into a
 * terminal surface via the terminal launch engine (src/lib/terminal).
 *
 * Unlike the single-select picker behind bare `agents sessions` (which resumes
 * one session in place), this opens a checkbox picker, then asks where the
 * chosen sessions should resume. By default each session opens in its own tab in
 * the terminal you're in — iTerm / Ghostty / tmux, locally or on a remote host
 * via --host. `--splits` opts into packing two sessions side by side per tab.
 */
import * as fs from 'fs';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { SessionMeta } from '../lib/session/types.js';
import { discoverSessions } from '../lib/session/discover.js';
import { filterTeamSessions } from '../lib/session/team-filter.js';
import { multiItemPicker, itemPicker } from '../lib/picker.js';
import { buildPreview } from './sessions-picker.js';
import {
  filterSessionsByQuery,
  formatPickerLabel,
  pickerColumnsFor,
  buildResumeCommand,
  resumeSessionInPlace,
  parseAgentFilter,
} from './sessions.js';
import {
  openSurfaces,
  availableBackends,
  detectCurrentBackend,
  currentContext,
  type Backend,
  type SurfaceItem,
  type EngineContext,
  type Packing,
} from '../lib/terminal/index.js';
import { resumeDestinationMismatch } from '../lib/session/resume-owner.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { confirm } from '@inquirer/prompts';

/** Opening more than this many live sessions at once asks for confirmation first. */
export const CONFIRM_THRESHOLD = 5;

interface ResumeOptions {
  agent?: string;
  all?: boolean;
  teams?: boolean;
  since?: string;
  limit?: string;
  host?: string;
  iterm?: boolean;
  ghostty?: boolean;
  tmux?: boolean;
  vscodium?: boolean;
  /** --terminal-app: force macOS Terminal.app. Named to avoid reading as `run --terminal`. */
  terminalApp?: boolean;
  splits?: boolean;
}

export function registerSessionsResumeCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('resume')
    .argument('[query]', 'Filter sessions before selecting (topic, path, or id fragment)')
    .description('Multi-select sessions and resume each in a terminal tab/split (this terminal, iTerm, Ghostty, tmux, VSCodium; local or --host).')
    .option('-a, --agent <agent>', 'Filter by agent type and version (e.g., claude, codex@0.116.0)')
    .option('--all', 'Include sessions from every directory (not just current project)')
    .option('--teams', 'Include team-spawned sessions (hidden by default)')
    .option('--since <time>', 'Only sessions newer than this (e.g., 2h, 7d, 4w, or ISO date)')
    .option('-n, --limit <n>', 'Maximum number of sessions to load into the picker', '200')
    .option('--host <alias>', 'Resume on a remote host over SSH (defaults to tmux there)')
    .option('--iterm', 'Force the iTerm backend')
    .option('--ghostty', 'Force the Ghostty backend')
    .option('--tmux', 'Force the tmux backend')
    .option('--vscodium', 'Force the VSCodium agent-terminal backend (swarm-ext)')
    .option('--terminal-app', 'Force macOS Terminal.app (no split support — panes become tabs)')
    .option('--splits', 'Pack two sessions side by side per tab (default: one tab per session)');

  setHelpSections(cmd, {
    examples: `
      # Pick several sessions; each opens in its own tab
      agents sessions resume

      # Pre-filter the pool before selecting (space in the filter → use [query])
      agents sessions resume "auth middleware"

      # Force a backend / side-by-side splits / a remote host
      agents sessions resume --ghostty
      agents sessions resume --vscodium
      agents sessions resume --splits
      agents sessions resume --host zion --tmux
    `,
    notes: `
      - space toggles a session, enter confirms; tab toggles the preview pane.
      - Layout: one tab per session by default. --splits packs session pairs side by side in each tab.
      - Backend: auto-detected from the terminal you're in (iTerm / Ghostty / tmux); override with --iterm/--ghostty/--tmux/--vscodium.
      - --vscodium opens each session as an agent terminal tab in VSCodium via the swarm-ext extension (works with --host too).
      - --host <alias> resumes on a remote machine over the same SSH transport as 'sessions --host' (defaults to tmux).
      - Each session opens version-pinned, in its own cwd. Non-resumable agents are skipped with a note.
    `,
  });

  cmd.action(async (query: string | undefined, options: ResumeOptions) => {
    await sessionsResumeAction(query, options);
  });
}

async function sessionsResumeAction(query: string | undefined, options: ResumeOptions): Promise<void> {
  if (!isInteractiveTerminal()) {
    console.error(chalk.red('sessions resume needs an interactive terminal.'));
    process.exitCode = 1;
    return;
  }

  const { agent, version } = parseAgentFilter(options.agent);
  const limit = parseInt(options.limit || '200', 10);
  const since = options.since ?? (options.all ? undefined : '30d');

  let sessions = await discoverSessions({
    agent,
    version,
    all: options.all,
    cwd: process.cwd(),
    since,
    sortBy: 'timestamp',
    limit,
    excludeTeamOrigin: !options.teams,
  });
  const { visible } = filterTeamSessions(sessions, !!options.teams);
  sessions = visible;

  if (sessions.length === 0) {
    console.log(chalk.gray('No sessions found. Try --all or a different --since window.'));
    return;
  }

  // 1. Multi-select the sessions. gutter: 6 = the multi-select cursor + checkbox
  // ('> [x] ') that multiItemPicker prepends, so rows size to fit without wrapping.
  const cols = { ...pickerColumnsFor(sessions), gutter: 6 };
  let chosen: SessionMeta[] | null;
  try {
    chosen = await multiItemPicker<SessionMeta>({
      message: 'Select sessions to resume:',
      items: sessions,
      filter: (q: string) => (q.trim() ? filterSessionsByQuery(sessions, q) : sessions),
      labelFor: (s, q) => formatPickerLabel(s, q, cols),
      keyFor: (s) => s.id,
      buildPreview,
      pageSize: 15,
      initialSearch: query,
      emptyMessage: 'No sessions match.',
      enterHint: 'resume',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return;
    throw err;
  }
  if (!chosen || chosen.length === 0) return;

  // 2. Split the selection into resumable surfaces and skipped sessions (no
  // silent drop): an agent with no resume support, or a session whose harness
  // state lives on a machine this batch is not opening tabs on.
  const destination = options.host;
  const items: Array<SurfaceItem & { session: SessionMeta }> = [];
  for (const s of chosen) {
    const command = buildResumeCommand(s);
    if (!command) {
      console.log(chalk.yellow(`  skip ${s.shortId} — resume is not supported for ${s.agent} sessions yet`));
      continue;
    }
    // The picker offers fleet-wide rows, so a peer-owned session can be
    // selected. Its transcript may even be readable here (a synced mirror), but
    // the harness's conversation state is not — and the cwd below would then
    // silently fall back to `process.cwd()`, resuming in whatever directory the
    // user happens to be in. Refuse it, naming the device (RUSH-2022).
    const mismatch = resumeDestinationMismatch(s, destination);
    if (mismatch) {
      console.log(
        chalk.yellow(`  skip ${s.shortId} — belongs to ${mismatch}`) +
          chalk.gray(destination
            ? `, not --host ${destination}. Run: agents sessions resume --host ${mismatch}`
            : `, not this machine. Run: agents resume ${s.id}`),
      );
      continue;
    }
    const cwd = resumeCwd(s, destination);
    if (cwd === undefined) {
      console.log(
        chalk.yellow(`  skip ${s.shortId} — no recorded working directory`) +
          chalk.gray(`, and this machine's cannot stand in for one on ${destination}`),
      );
      continue;
    }
    items.push({ session: s, cwd, command });
  }
  if (items.length === 0) {
    console.log(chalk.gray('Nothing resumable in the selection.'));
    return;
  }

  // 3. Resolve the backend (and host).
  const ctx = currentContext();
  const backend = await resolveBackend(options, ctx, items.length);
  if (backend === 'cancel') return;

  // 4. Guard against opening a flood of live agents.
  if (items.length > CONFIRM_THRESHOLD) {
    const proceed = await confirm({
      message: `Open ${items.length} live sessions at once?`,
      default: false,
    }).catch(() => false);
    if (!proceed) return;
  }

  // 5a. No tab-capable backend (off-macOS, not in tmux, local) — resume in place, sequentially.
  if (backend === 'inplace') {
    if (items.length > 1) {
      console.log(chalk.gray(`Resuming ${items.length} sessions one at a time (no tab-capable terminal detected).`));
    }
    for (const it of items) await resumeSessionInPlace(it.session);
    return;
  }

  // 5b. Fan out through the engine. Full-width tabs are the default for batch
  // recovery; callers can explicitly opt into pairs of side-by-side panes.
  const packing = resolveResumePacking(options);
  const where = options.host ? `${backend} on ${options.host}` : backend;
  // Terminal.app has no scriptable split, so its buildSplit opens a tab. Say so
  // when the user actually asked for panes — the layout silently not happening
  // is worse than one line of warning.
  if (backend === 'terminal' && packing === 'two-per-tab') {
    console.log(chalk.yellow('Terminal.app cannot split panes — opening one tab per session instead.'));
  }
  console.log(chalk.gray(`Opening ${items.length} session${items.length === 1 ? '' : 's'} in ${where} (${packing})…`));

  const results = await openSurfaces(
    items.map((it) => ({ cwd: it.cwd, command: it.command })),
    { backend, host: options.host, packing },
  );

  let opened = 0;
  results.forEach((r, i) => {
    const s = items[i].session;
    if (r.ok) {
      opened++;
      const shape = r.request.layout === 'tab' ? 'tab' : 'split';
      console.log(chalk.green(`  opened ${s.shortId}`) + chalk.gray(` — ${shape} — ${items[i].command.join(' ')}`));
    } else {
      console.log(chalk.red(`  failed ${s.shortId} — ${r.error}`));
    }
  });
  console.log(chalk.gray(`\nOpened ${opened}/${items.length} in ${where}.`));
}

export function resolveResumePacking(options: Pick<ResumeOptions, 'splits'>): Packing {
  return options.splits ? 'two-per-tab' : 'tabs';
}

/**
 * The directory a resumed session's tab should open in, or `undefined` when this
 * machine has nothing truthful to offer.
 *
 * The recorded `cwd` belongs to the session's own machine, so probing it with a
 * LOCAL `fs.existsSync` only means something when the tabs open locally. With
 * `--host <device>` the tab is a `tmux new-window -c <cwd>` over there: a
 * directory absent here may well exist on that box, and substituting this box's
 * `process.cwd()` hands the peer a path it does not have. That substitution is
 * the same defect as the wrong-machine resume — an existsSync on the wrong
 * machine deciding a remote path (RUSH-2022) — so remote batches take the record
 * as written, and a session with no record at all is refused rather than opened
 * somewhere invented.
 *
 * `exists` is injectable so the local branch is testable without touching disk.
 */
export function resumeCwd(
  session: Pick<SessionMeta, 'cwd'>,
  destination: string | undefined,
  exists: (p: string) => boolean = fs.existsSync,
): string | undefined {
  if (destination) return session.cwd || undefined;
  return session.cwd && exists(session.cwd) ? session.cwd : process.cwd();
}

/**
 * Decide which backend to launch into. Returns a concrete backend, `'inplace'`
 * (resume in the current process — no GUI/tmux available), or `'cancel'` (the
 * user dismissed the chooser).
 */
export async function resolveBackend(
  options: ResumeOptions,
  ctx: EngineContext,
  count: number,
): Promise<Backend | 'inplace' | 'cancel'> {
  const forced: Backend | undefined =
    options.iterm ? 'iterm'
      : options.ghostty ? 'ghostty'
      : options.tmux ? 'tmux'
      : options.vscodium ? 'vscodium-agent'
      : options.terminalApp ? 'terminal'
      : undefined;
  if (forced) return forced;
  // Remote defaults to tmux (headless, no GUI session assumptions); override with a backend flag.
  if (options.host) return 'tmux';

  const available = availableBackends(ctx);
  if (available.length === 0) return 'inplace';

  const detected = detectCurrentBackend(ctx);
  // Only one option and it's where we already are → no need to ask.
  if (available.length === 1 && (!detected || detected === available[0].id)) return available[0].id;

  interface BackendChoice { id: Backend; label: string; detail: string; }
  const choices: BackendChoice[] = available.map((b) => ({
    id: b.id,
    label: b.label,
    detail: b.id === detected ? "the terminal you're in now" : `open in ${b.label}`,
  }));
  try {
    const picked = await itemPicker<BackendChoice>({
      message: `Resume ${count} session${count === 1 ? '' : 's'} where?`,
      items: choices,
      filter: () => choices,
      labelFor: (c) => `${chalk.bold(c.label.padEnd(10))}${chalk.gray(c.detail)}`,
      shortIdFor: (c) => c.label,
      enterHint: 'open',
    });
    return picked ? picked.item.id : 'cancel';
  } catch (err) {
    if (isPromptCancelled(err)) return 'cancel';
    throw err;
  }
}
