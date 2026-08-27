/**
 * Remote half of PHNX-3292: race live tmux panes across the fleet and attach
 * the first unique hit. The local half is `local-tmux-attach.ts` (zero SSH).
 *
 * `sessions resume` / `sessions focus` / deprecated `sessions attach` take the
 * local gate first. On a miss they call {@link attachFleetLiveSelector}, which
 * fans `agents tmux list --json` in parallel with RUSH-2203's `earlyExit` so
 * the first reachable unique live pane attaches immediately — unanswered /
 * offline peers are aborted, not waited out, and never print a skip-list on a
 * hit. `--device` scopes the race to the named box(es). Two answered
 * collisions fail closed with both `device:name`. A dead/retained pane is
 * never a definitive hit and is never attached.
 */
import chalk from 'chalk';
import { gatherRemoteAgentsJson, type GatherRemoteAgentsJsonDeps, type RemoteAgentsJsonResult } from '../remote-agents-json.js';
import { assertValidSshTarget, shellQuote, sshStream } from '../ssh-exec.js';
import { NO_FANOUT_ENV } from './remote-active.js';
import { isAgentTmuxAlias } from './types.js';

/** Width of `SessionMeta.shortId` / the hex an `ag-<agent>-<8hex>` alias embeds. */
const SHORT_SESSION_ID_RE = /^[0-9a-f]{8}$/i;

export interface RemoteTmuxSession {
  machine: string;
  name: string;
  socket?: string;
  /** False when every pane is dead (`remain-on-exit` corpse). Missing on older peers. */
  live?: boolean;
}

export interface FleetTmuxAttachOpts {
  hosts?: string[];
  local?: boolean;
}

export interface FleetTmuxAttachDeps extends GatherRemoteAgentsJsonDeps {
  gather?: typeof gatherRemoteAgentsJson;
  /** Injected so tests can assert the attach target without replacing this TTY. */
  attach?: (hit: RemoteTmuxSession) => Promise<void>;
}

/** Selectors the fleet live-tmux race is willing to early-exit on. */
export function isFleetTmuxSelector(selector: string | undefined): selector is string {
  if (!selector) return false;
  const q = selector.trim();
  return isAgentTmuxAlias(q) || SHORT_SESSION_ID_RE.test(q);
}

/**
 * A tmux session name matches the selector when it is the exact `ag-<agent>-<8hex>`
 * alias, or (for a bare 8-hex) when the name is an agent alias ending in that hex.
 */
export function remoteTmuxNameMatchesSelector(name: string, selector: string): boolean {
  const q = selector.trim().toLowerCase();
  const n = name.toLowerCase();
  if (isAgentTmuxAlias(q)) return n === q;
  if (SHORT_SESSION_ID_RE.test(q)) return isAgentTmuxAlias(n) && n.endsWith(q);
  return false;
}

/** First-hit abort + uniqueness: live panes only. A missing `live` (old peer) still
 *  opts in — attach re-reads pane_dead before replacing the TTY. */
export function isDefinitiveRemoteTmuxHit(item: RemoteTmuxSession, selector: string): boolean {
  return item.live !== false && remoteTmuxNameMatchesSelector(item.name, selector);
}

/** Parse a peer's `agents tmux list --json` into name/socket/live rows tagged with
 *  the dialed machine. Non-JSON or a non-array is a miss, never a throw. */
export function parseRemoteTmuxList(stdout: string, machine: string): RemoteTmuxSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RemoteTmuxSession[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const rec = row as { name?: unknown; socket?: unknown; live?: unknown };
    if (typeof rec.name !== 'string' || rec.name.length === 0) continue;
    out.push({
      machine,
      name: rec.name,
      socket: typeof rec.socket === 'string' ? rec.socket : undefined,
      live: typeof rec.live === 'boolean' ? rec.live : undefined,
    });
  }
  return out;
}

export function remoteTmuxAttachScript(hit: Pick<RemoteTmuxSession, 'name' | 'socket'>): string {
  const sock = hit.socket ? `-S ${shellQuote(hit.socket)} ` : '';
  const sess = shellQuote(hit.name);
  return [
    `tmux ${sock}attach-session -t =${sess}`,
    'code=$?',
    `panes=$(tmux ${sock}list-panes -t =${sess} -F '#{pane_dead}' 2>/dev/null) || exit $code`,
    'echo "$panes" | grep -q \'^0$\' && exit $code',
    `tmux ${sock}kill-session -t =${sess} 2>/dev/null`,
    'exit $code',
  ].join('; ');
}

/**
 * Race live tmux panes on the fleet. Returns true when the selector was
 * consumed (attached, or a collision reported). Returns false on a genuine
 * miss so the caller can fall through to index resume / recovery.
 *
 * `--local` skips the race (rule 1 already handled locally). `--device` is
 * the only dial (rule 4). Quiet fan-out: cancelled/offline peers do not
 * print a skip-list on a hit (AC2).
 */
export async function attachFleetLiveSelector(
  selector: string | undefined,
  opts: FleetTmuxAttachOpts,
  deps: FleetTmuxAttachDeps = {},
): Promise<boolean> {
  if (opts.local) return false;
  if (!isFleetTmuxSelector(selector)) return false;
  const q = selector.trim();
  const hosts = opts.hosts && opts.hosts.length > 0 ? opts.hosts : undefined;

  const remote: RemoteAgentsJsonResult<RemoteTmuxSession> = await (deps.gather ?? gatherRemoteAgentsJson)({
    args: ['tmux', 'list', '--json'],
    noFanoutEnv: NO_FANOUT_ENV,
    hosts,
    parse: parseRemoteTmuxList,
    quiet: true,
    earlyExit: { isDefinitive: (item) => isDefinitiveRemoteTmuxHit(item, q) },
  }, deps);

  const hits = dedupeRemoteTmuxHits(remote.items.filter((item) => isDefinitiveRemoteTmuxHit(item, q)));
  if (hits.length === 0) return false;
  if (hits.length > 1) {
    console.error(chalk.red(
      `"${q}" matches ${hits.length} live panes: ${hits.map((h) => `${h.machine}:${h.name}`).join(', ')}`,
    ));
    console.error(chalk.gray('  Pass the full alias and --device to disambiguate — see: agents tmux ls'));
    process.exitCode = 1;
    return true;
  }

  const hit = hits[0];
  if (deps.attach) {
    await deps.attach(hit);
    return true;
  }
  await attachRemoteTmuxSession(hit);
  return true;
}

function dedupeRemoteTmuxHits(hits: RemoteTmuxSession[]): RemoteTmuxSession[] {
  const byKey = new Map<string, RemoteTmuxSession>();
  for (const hit of hits) {
    const key = `${hit.machine}:${hit.name}`;
    if (!byKey.has(key)) byKey.set(key, hit);
  }
  return [...byKey.values()];
}

async function attachRemoteTmuxSession(hit: RemoteTmuxSession): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error(chalk.red(`"${hit.name}" is a live tmux session on ${hit.machine}, but attaching needs a TTY.`));
    console.error(chalk.gray(`  Run it from a terminal, or: agents ssh ${hit.machine} -- agents tmux attach ${hit.name}`));
    process.exitCode = 1;
    return;
  }
  assertValidSshTarget(hit.machine);
  console.log(chalk.gray(`Attaching ${hit.name} on ${hit.machine} over SSH — Ctrl-b d to detach.`));
  process.exitCode = sshStream(hit.machine, remoteTmuxAttachScript(hit), { tty: true });
}
