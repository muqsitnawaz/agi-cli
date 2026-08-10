import type { ActiveSession } from './active.js';
import type { SessionMeta } from './types.js';
import { normalizeHost } from '../machine-id.js';
import { viewingInLabel } from './viewing-in.js';

export type ResumeCandidateState = 'detached' | 'background' | 'parked' | 'inactive' | 'watched';

const STATE_RANK: Record<ResumeCandidateState, number> = {
  detached: 0,
  background: 1,
  parked: 2,
  inactive: 3,
  watched: 4,
};

export interface SessionResumeCandidate {
  id: string;
  shortId: string;
  agent: string;
  version?: string;
  account?: string;
  project?: string;
  cwd?: string;
  topic?: string;
  state: ResumeCandidateState;
  /** Canonical picker predicate: false only when another terminal is watching. */
  unwatched: boolean;
  viewingIn: string;
  host: string;
  sourceHost: string;
  lastActivityMs: number;
  pid: number;
  recovery: {
    command: 'agents';
    args: string[];
    cwd?: string;
  };
}

function cleanText(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const text = value?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return undefined;
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resumeCandidateState(live: ActiveSession | undefined): ResumeCandidateState {
  if (!live || live.pid === 0 || live.pidAlive === false || live.status === 'closed' || live.status === 'crashed') {
    return 'inactive';
  }
  if (live.presence === 'background') return 'background';
  if (live.presence === 'parked') return 'parked';
  return viewingInLabel(live) === 'detached' ? 'detached' : 'watched';
}

/** Project the browser's canonical recent + live union into stable snapshot rows. */
export function buildSessionResumeCandidates(
  sessions: SessionMeta[],
  liveById: Map<string, ActiveSession>,
  self: string,
): SessionResumeCandidate[] {
  const local = normalizeHost(self);
  const seen = new Set<string>();
  const candidates: SessionResumeCandidate[] = [];

  for (const session of sessions) {
    if (!session.id || seen.has(session.id)) continue;
    seen.add(session.id);
    const live = liveById.get(session.id);
    // The browser may project an id-less process as `p:<pid>` so it can still
    // render a roster row. That locator is not a durable resume identity.
    if (live && !live.sessionId) continue;
    const state = resumeCandidateState(live);
    const sourceHost = normalizeHost(session.machine ?? live?.machine ?? self);
    const host = sourceHost === local ? '' : sourceHost;
    const viewer = live ? viewingInLabel(live) : undefined;
    candidates.push({
      id: session.id,
      shortId: session.shortId || session.id.slice(0, 8),
      agent: session.agent || live?.kind || '',
      version: session.version,
      account: session.account,
      project: session.project ?? (live?.cwd ? live.cwd.split('/').filter(Boolean).pop() : undefined),
      cwd: session.cwd ?? live?.cwd,
      topic: cleanText(session.label, session.topic, live?.label, live?.topic),
      state,
      unwatched: state !== 'watched',
      viewingIn: viewer && viewer !== 'detached' ? viewer : '',
      host,
      sourceHost,
      lastActivityMs: Math.max(timestampMs(session.lastActivity), timestampMs(session.timestamp), live?.lastActivityMs ?? 0),
      pid: live?.pid ?? 0,
      recovery: {
        command: 'agents',
        args: ['sessions', 'resume', session.id, ...(host ? ['--host', host] : [])],
        cwd: session.cwd ?? live?.cwd,
      },
    });
  }

  return candidates.sort((a, b) => {
    const state = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (state !== 0) return state;
    if (a.lastActivityMs !== b.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
    return a.id.localeCompare(b.id);
  });
}
