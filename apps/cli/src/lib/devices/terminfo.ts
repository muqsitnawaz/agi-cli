/**
 * Terminal-type (`$TERM` / terminfo) handling for `agents ssh` interactive logins.
 *
 * Modern terminal emulators — Ghostty, kitty, WezTerm, foot, rio — ship their
 * own terminfo entry and export an exotic `$TERM` (`xterm-ghostty`,
 * `xterm-kitty`, `wezterm`, …). A plain `ssh -tt` forwards that `$TERM` to the
 * remote through the pty request. If the remote's terminfo database has no
 * matching entry, every ncurses program breaks — `clear`, `tput`, `vim`,
 * `less`, `tmux`, and the shell's line editor all error with
 * `'xterm-ghostty': unknown terminal type`. That is why a bare `agents ssh`
 * from one of these terminals lands you in a session where nothing renders.
 *
 * We fix it the way the emulators themselves do:
 *  1. **Propagate** the local terminfo entry to the remote — pipe `infocmp`
 *     here into `tic` there, installing it under the remote user's
 *     `~/.terminfo`. The remote then understands the real `$TERM` with full
 *     fidelity (extended capabilities — styled underlines, the kitty keyboard
 *     protocol — intact).
 *  2. **Fall back** to a universally-present `$TERM` (`xterm-256color`) when
 *     propagation can't happen: the local box has no entry to copy, `tic` is
 *     absent on the remote, or the remote is Windows. A degraded-but-working
 *     session always beats a broken one.
 *
 * Terminals whose entry ships in every base terminfo database (`xterm`,
 * `xterm-256color`, `screen`, `tmux`, `vt100`, `linux`, …) are left untouched:
 * no round-trip, no override. The per-(host,term) decision is cached so the
 * propagation handshake happens at most once per host+terminal.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../state.js';
import { buildSshInvocation, type SshHostKeyOptions } from './connect.js';
import { type DeviceProfile } from './registry.js';

/**
 * Terminals present in essentially every POSIX terminfo database. When the
 * local `$TERM` is one of these there is nothing to fix — ssh forwards it and
 * the remote already understands it.
 */
const SAFE_TERMS = new Set([
  'xterm',
  'xterm-color',
  'xterm-256color',
  'screen',
  'screen-256color',
  'tmux',
  'tmux-256color',
  'vt100',
  'vt220',
  'ansi',
  'linux',
  'dumb',
  'rxvt',
  'rxvt-unicode',
  'rxvt-unicode-256color',
]);

/** The compatibility `$TERM` used when the real one can't be made to work remotely. */
export const FALLBACK_TERM = 'xterm-256color';

/**
 * A valid terminfo name: begins with a letter, then letters/digits and the
 * punctuation terminfo uses (`-`, `+`, `.`, `_`). This is both a correctness
 * check and an injection guard — the name is interpolated into a remote shell
 * command and passed to local `infocmp`, so anything outside this set is refused.
 */
const TERM_NAME_RE = /^[A-Za-z][A-Za-z0-9._+-]*$/;

/**
 * True when `term` is an exotic terminal worth handling — non-empty, a valid
 * terminfo name, and NOT one of the universally-present {@link SAFE_TERMS}.
 * Everything a plain `agents ssh` already handles correctly returns false.
 */
export function isManagedTerm(term: string | undefined): term is string {
  return !!term && TERM_NAME_RE.test(term) && !SAFE_TERMS.has(term);
}

/**
 * The local terminfo source for `term`, as portable text, or null when it
 * can't be produced (no `infocmp`, or the local database has no such entry).
 * `-x` keeps user-defined/extended capabilities (the whole point for kitty/
 * Ghostty); `-q -0` yields a compact single-line-per-entry form `tic` accepts.
 */
export function localTerminfoSource(term: string): string | null {
  if (!TERM_NAME_RE.test(term)) return null;
  const res = spawnSync('infocmp', ['-x', '-q', '-0', term], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout || !res.stdout.trim()) return null;
  return res.stdout;
}

/**
 * The remote command that installs a piped terminfo source under `~/.terminfo`
 * and then verifies the entry is readable. Self-verifying (`&& infocmp`) so a
 * zero exit genuinely means "the remote now understands this `$TERM`", not just
 * "tic ran". `term` is validated by the callers ({@link isManagedTerm}) before
 * it reaches here.
 */
export function remoteTicCommand(term: string): string {
  return `tic -x -o "$HOME/.terminfo" - && infocmp -x ${term} >/dev/null 2>&1`;
}

/**
 * The override `$TERM` to force on the ssh child, or undefined to leave the
 * inherited value alone. Pure: safe terminals and successfully-propagated
 * exotic terminals keep their real `$TERM` (undefined); an exotic terminal we
 * could not propagate is downgraded to {@link FALLBACK_TERM}.
 */
export function resolveLoginTerm(localTerm: string | undefined, propagated: boolean): string | undefined {
  if (!isManagedTerm(localTerm)) return undefined; // safe/absent term — forward as-is
  return propagated ? undefined : FALLBACK_TERM;
}

type TerminfoDecision = 'ok' | 'downgrade';

function terminfoCacheDir(): string {
  return path.join(getCacheDir(), 'devices', 'terminfo');
}

/** Filesystem-safe sentinel name for a (host, term) pair. */
function cacheKey(host: string, term: string): string {
  return `${host}__${term}`.replace(/[^A-Za-z0-9._+-]/g, '_');
}

/**
 * The cached propagation decision for a (host, term), or null if we've never
 * connected with this terminal to this host. Caching makes the propagation
 * handshake a once-per-host+term cost; steady-state logins pay nothing.
 */
export function readTerminfoDecision(host: string, term: string, dir = terminfoCacheDir()): TerminfoDecision | null {
  try {
    const val = fs.readFileSync(path.join(dir, cacheKey(host, term)), 'utf-8').trim();
    return val === 'ok' || val === 'downgrade' ? val : null;
  } catch {
    return null;
  }
}

/** Persist the propagation decision for a (host, term). Best-effort. */
export function writeTerminfoDecision(host: string, term: string, decision: TerminfoDecision, dir = terminfoCacheDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, cacheKey(host, term)), decision);
  } catch {
    /* best-effort — a missing cache just re-runs the (idempotent) handshake next time */
  }
}

/**
 * Try to install the local terminfo entry for `term` on `device`, reusing the
 * device's exact auth/host-key posture via {@link buildSshInvocation}. Returns
 * true only when the remote confirms the entry is now readable. Any failure
 * (no local source, no remote `tic`, unreachable) returns false so the caller
 * downgrades `$TERM` instead.
 */
export function propagateTerminfo(
  device: DeviceProfile,
  term: string,
  askpassShimPath: string,
  hostKey: SshHostKeyOptions = {},
): boolean {
  const source = localTerminfoSource(term);
  if (!source) return false; // nothing to copy — the local box lacks this entry
  const { args, env } = buildSshInvocation(device, [remoteTicCommand(term)], askpassShimPath, hostKey);
  const res = spawnSync('ssh', args, {
    input: source,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 20_000,
    windowsHide: true,
  });
  return res.status === 0;
}
