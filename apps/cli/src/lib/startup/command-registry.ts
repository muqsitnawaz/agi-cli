const LOADED_COMMAND_NAMES = [
  'accounts', 'view', 'inspect', 'feedback', 'commands', 'hooks', 'skills', 'rules', 'memory',
  'permissions', 'mcp', 'clis', 'subagents', 'plugins', 'workflows', 'add', 'use', 'list',
  'remove', 'rm', 'purge', 'update', 'prune', 'import', 'registry', 'search', 'install',
  'routines', 'monitors', 'projects', 'run', 'open', 'reconnect', 'fork', 'config',
  'models', 'modes', 'trash', 'restore', 'doctor', 'apply', 'status',
  'route', 'harness', 'harnesses', 'secrets', 'menubar', 'beta', 'sync',
  'refresh-rules', 'factory', 'usage', 'insights', 'perf', 'trends',
  'alias', 'pty', 'tmux', 'watchdog', 'browser', 'computer', 'logs', 'events',
  'ssh', 'devices', 'fleet', 'repos', 'repo', 'setup', 'uninstall', 'upgrade', 'sessions',
  'teams', 'tickets', 'cloud', 'message', 'send', 'notify', 'feed', 'inbox',
  'timeline', 'mailboxes', 'mailbox', 'serve', 'artifacts', 'unshare', 'audit', 'webhooks',
  'humans', 'daemon',
] as const;

const INLINE_COMMAND_NAMES = [
  'perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', '_internal',
] as const;

export const KNOWN_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set<string>([
  ...LOADED_COMMAND_NAMES,
  ...INLINE_COMMAND_NAMES,
]);

/**
 * Former top-level names that must NOT auto-correct (edit-distance 1) into a
 * live command. Without this a pruned surface silently misroutes: the typed
 * name is gone, the spellchecker finds a neighbour, and the CLI runs something
 * the user never asked for instead of saying the command is gone.
 *
 * `set` moved under `agents models`/`agents config` (RUSH-2579); `share` moved
 * under `agents artifacts share` (RUSH-2580). login/logout/budget/bench/mine/
 * cost/output/profiles/snapshot/cp/resume/roster moved under nested homes
 * (cli-surface-consolidate).
 */
export const RETIRED_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set([
  'webhook',
  'login',
  'logout',
  'budget',
  'bench',
  'mine',
  'cost',
  'output',
  'profiles',
  'snapshot',
  'cp',
  'resume',
  'roster',
  'set',
  'share',
]);

export function isKnownTopLevelCommand(name: string): boolean {
  return KNOWN_TOP_LEVEL_COMMANDS.has(name);
}
