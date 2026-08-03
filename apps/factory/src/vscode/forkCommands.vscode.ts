import { buildForkSessionRequest, type ForkSessionSource } from '../core/forkSession';
import type { RunStrategy } from '../core/agents';

export interface ForkPickHostLaunch<ViewColumn> {
  prompt: string;
  strategy?: RunStrategy;
  host?: string;
  local: boolean;
  viewColumn: ViewColumn;
}

export interface ForkPickHostRecord {
  sourceSessionId: string;
  sourceHost: string;
  forkSessionId: string | null;
  forkHost: string;
  agentKey: string;
  forkedAt: number;
  terminalId: string;
}

/** Keep the VS Code command id coupled to its executable handler. */
export function registerForkPickHostCommand<Disposable>(
  register: (command: string, callback: () => Promise<void>) => Disposable,
  run: () => Promise<void>,
): Disposable {
  return register('agents.forkPickHost', run);
}

/**
 * The executable `Agents: Fork (Pick Host)` path. The extension supplies VS Code
 * effects; this seam keeps one production implementation testable end-to-end.
 */
export async function handleForkPickHost<ViewColumn>(opts: {
  source: ForkSessionSource & { localHost: string };
  pickHost: (agentKey: string) => Promise<{ host?: string; cancelled: boolean }>;
  openFork: (launch: ForkPickHostLaunch<ViewColumn>) => Promise<{ terminalId: string; sessionId: string | null }>;
  recordFork: (edge: ForkPickHostRecord) => void;
  showRejection: (reason: 'no_session' | 'no_agent') => void;
  viewColumn: ViewColumn;
  now: () => number;
}): Promise<void> {
  const dryRun = buildForkSessionRequest(opts.source);
  if (!dryRun.ok) {
    opts.showRejection(dryRun.reason);
    return;
  }

  const picked = await opts.pickHost(dryRun.agentKey);
  if (picked.cancelled) return;

  const request = buildForkSessionRequest(opts.source, { host: picked.host });
  if (!request.ok) {
    opts.showRejection(request.reason);
    return;
  }

  const fork = await opts.openFork({
    prompt: request.prompt,
    strategy: request.strategy,
    host: request.host,
    local: request.local,
    viewColumn: opts.viewColumn,
  });
  opts.recordFork({
    sourceSessionId: request.sessionId,
    sourceHost: request.sourceHost ?? opts.source.localHost,
    forkSessionId: fork.sessionId,
    forkHost: request.host ?? opts.source.localHost,
    agentKey: request.agentKey,
    forkedAt: opts.now(),
    terminalId: fork.terminalId,
  });
}
