import { normalizeHost } from '../machine-id.js';
import type { ActiveSession } from './active.js';
import type { SessionMeta } from './types.js';
import { viewingInLabel } from './viewing-in.js';

export type SessionLifecycleState = 'detached' | 'background' | 'parked' | 'inactive' | 'watched';

const STATE_RANK: Record<SessionLifecycleState, number> = {
  detached: 0,
  background: 1,
  parked: 2,
  inactive: 3,
  watched: 4,
};

/** Canonical `agents sessions --all --json` row: durable metadata plus live lifecycle. */
export interface SessionJsonRow extends SessionMeta {
  state: SessionLifecycleState;
  resumable: true;
  unwatched: boolean;
  viewingIn: string;
  sourceDevice: string;
  lastActivityMs: number;
  pid: number;
  recovery: {
    command: 'agents';
    args: string[];
    cwd?: string;
  };
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sessionLifecycleState(live: ActiveSession | undefined): SessionLifecycleState {
  if (!live || live.pid === 0 || live.pidAlive === false || live.status === 'closed' || live.status === 'crashed') {
    return 'inactive';
  }
  if (live.presence === 'background') return 'background';
  if (live.presence === 'parked') return 'parked';
  return viewingInLabel(live) === 'detached' ? 'detached' : 'watched';
}

/** Join durable rows to the one live gather and apply the stable resume-list order. */
export function enrichSessionJsonRows(
  sessions: SessionMeta[],
  liveById: Map<string, ActiveSession>,
  self: string,
): SessionJsonRow[] {
  const local = normalizeHost(self);
  const seen = new Set<string>();
  const rows: SessionJsonRow[] = [];

  for (const session of sessions) {
    if (!session.id || seen.has(session.id)) continue;
    seen.add(session.id);
    const live = liveById.get(session.id);
    // `p:<pid>` is a roster locator, not a durable identity that resume accepts.
    if (live && !live.sessionId) continue;
    const state = sessionLifecycleState(live);
    const sourceDevice = normalizeHost(session.machine ?? live?.machine ?? self);
    const remote = sourceDevice !== local;
    const viewer = live ? viewingInLabel(live) : undefined;
    rows.push({
      // Preserve the established `--active --json` fields (context, kind,
      // status, activity, pidAlive, provenance, refs) when this durable row is
      // reached through a lifecycle filter. Durable metadata then wins shared
      // names, and the canonical fields below normalize the join.
      ...(live ?? {}),
      ...session,
      state,
      resumable: true,
      unwatched: state !== 'watched',
      viewingIn: viewer && viewer !== 'detached' ? viewer : '',
      sourceDevice,
      lastActivityMs: Math.max(timestampMs(session.lastActivity), timestampMs(session.timestamp), live?.lastActivityMs ?? 0),
      pid: live?.pid ?? 0,
      recovery: {
        command: 'agents',
        args: ['sessions', 'resume', session.id, ...(remote ? ['--host', sourceDevice] : [])],
        cwd: session.cwd ?? live?.cwd,
      },
    });
  }

  return rows.sort((a, b) => {
    const state = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (state !== 0) return state;
    if (a.lastActivityMs !== b.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
    return a.id.localeCompare(b.id);
  });
}
