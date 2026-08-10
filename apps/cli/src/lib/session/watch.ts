import { createHash, randomUUID } from 'node:crypto';
import type { ActiveSession } from './active.js';
import { loadLocalActiveSessions } from './session-cache.js';

export const SESSION_WATCH_VERSION = 1 as const;
export const SESSION_WATCH_REFRESH_MS = 10_000;
export const SESSION_WATCH_HEARTBEAT_MS = 15_000;

export type SessionWatchScopeStatus = 'available' | 'unavailable';

export type SessionWatchEnvelope =
  | { version: 1; type: 'reset'; streamId: string; sequence: number; scope: string; rows: SessionWatchRow[] }
  | { version: 1; type: 'upsert'; streamId: string; sequence: number; scope: string; rowKey: string; row: SessionWatchRow }
  | { version: 1; type: 'remove'; streamId: string; sequence: number; scope: string; rowKey: string }
  | { version: 1; type: 'scope'; streamId: string; sequence: number; scope: string; status: SessionWatchScopeStatus; reason?: string }
  | { version: 1; type: 'heartbeat'; streamId: string; sequence: number; scope: string; capturedAt: number };

export interface SessionWatchRow extends Omit<ActiveSession, 'viewingIn'> {
  rowKey: string;
  sourceDevice: string;
  resumable: boolean;
  unwatched: boolean;
  viewingIn: string | null;
  recovery: { command: 'agents'; args: string[]; cwd?: string } | null;
}

/** Stable, opaque identity for one row within one device scope. */
export function sessionWatchRowKey(scope: string, row: ActiveSession): string {
  const identity = row.sessionId ?? `${row.context}:${row.kind}:${row.pid ?? ''}:${row.startedAtMs ?? ''}`;
  return createHash('sha256').update(`${scope}\0${identity}`).digest('base64url').slice(0, 22);
}

export function toSessionWatchRow(scope: string, row: ActiveSession): SessionWatchRow {
  const rowKey = sessionWatchRowKey(scope, row);
  const resumable = Boolean(row.sessionId);
  const viewingIn = row.viewingIn
    ? [row.viewingIn.app, row.viewingIn.tab ? `tab ${row.viewingIn.tab}` : undefined].filter(Boolean).join(' ')
    : null;
  return {
    ...row,
    rowKey,
    sourceDevice: scope,
    resumable,
    unwatched: !viewingIn,
    viewingIn,
    recovery: resumable
      ? { command: 'agents', args: ['sessions', 'resume', row.sessionId!, '--device', scope], ...(row.cwd ? { cwd: row.cwd } : {}) }
      : null,
  };
}

function sameRow(a: SessionWatchRow, b: SessionWatchRow): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Stream-local sequencer and convergent row diff. */
export class SessionWatchState {
  readonly streamId: string;
  private sequence = 0;
  private readonly rows = new Map<string, Map<string, SessionWatchRow>>();

  constructor(streamId: string = randomUUID()) { this.streamId = streamId; }

  private base<T extends SessionWatchEnvelope['type']>(type: T): { version: 1; type: T; streamId: string; sequence: number } {
    return { version: SESSION_WATCH_VERSION, type, streamId: this.streamId, sequence: ++this.sequence };
  }

  reset(scope: string, sourceRows: ActiveSession[]): SessionWatchEnvelope {
    const rows = sourceRows.map((row) => toSessionWatchRow(scope, row));
    this.rows.set(scope, new Map(rows.map((row) => [row.rowKey, row])));
    return { ...this.base('reset'), scope, rows };
  }

  update(scope: string, sourceRows: ActiveSession[]): SessionWatchEnvelope[] {
    const previous = this.rows.get(scope) ?? new Map<string, SessionWatchRow>();
    const nextRows = sourceRows.map((row) => toSessionWatchRow(scope, row));
    const next = new Map(nextRows.map((row) => [row.rowKey, row]));
    const events: SessionWatchEnvelope[] = [];
    for (const [rowKey, row] of next) {
      if (!previous.has(rowKey) || !sameRow(previous.get(rowKey)!, row)) {
        events.push({ ...this.base('upsert'), scope, rowKey, row });
      }
    }
    for (const rowKey of previous.keys()) {
      if (!next.has(rowKey)) events.push({ ...this.base('remove'), scope, rowKey });
    }
    this.rows.set(scope, next);
    return events;
  }

  scope(scope: string, status: SessionWatchScopeStatus, reason?: string): SessionWatchEnvelope {
    // Deliberately retain rows while unavailable. A reconnecting scope replaces
    // them with a reset; transient fleet loss must not look like session death.
    return { ...this.base('scope'), scope, status, ...(reason ? { reason } : {}) };
  }

  heartbeat(scope: string, capturedAt: number = Date.now()): SessionWatchEnvelope {
    return { ...this.base('heartbeat'), scope, capturedAt };
  }
}

export interface WatchLocalOptions {
  scope: string;
  signal: AbortSignal;
  emit: (event: SessionWatchEnvelope) => void;
  refreshMs?: number;
  heartbeatMs?: number;
  load?: typeof loadLocalActiveSessions;
}

/**
 * Keep one local subscription alive. This reads only the live cache/state path,
 * never transcript history. The 10-second refresh also closes the old gap where
 * the 15-second cache could outlive the daemon's three-minute warm routine.
 */
export async function watchLocalSessions(options: WatchLocalOptions): Promise<void> {
  const state = new SessionWatchState();
  const load = options.load ?? loadLocalActiveSessions;
  const refreshMs = options.refreshMs ?? SESSION_WATCH_REFRESH_MS;
  const heartbeatMs = options.heartbeatMs ?? SESSION_WATCH_HEARTBEAT_MS;
  let first = true;
  let refreshing = false;
  const refresh = async () => {
    if (refreshing || options.signal.aborted) return;
    refreshing = true;
    try {
      const result = await load();
      if (first) {
        options.emit(state.reset(options.scope, result.sessions));
        options.emit(state.scope(options.scope, 'available'));
        first = false;
      } else {
        for (const event of state.update(options.scope, result.sessions)) options.emit(event);
      }
    } catch (error) {
      options.emit(state.scope(options.scope, 'unavailable', error instanceof Error ? error.message : String(error)));
    } finally {
      refreshing = false;
    }
  };
  await refresh();
  if (options.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const refreshTimer = setInterval(() => void refresh(), refreshMs);
    const heartbeatTimer = setInterval(() => options.emit(state.heartbeat(options.scope)), heartbeatMs);
    const stop = () => { clearInterval(refreshTimer); clearInterval(heartbeatTimer); resolve(); };
    options.signal.addEventListener('abort', stop, { once: true });
  });
}
