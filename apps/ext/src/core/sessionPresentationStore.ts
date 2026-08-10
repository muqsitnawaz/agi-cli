import type { SessionCliFactPayload } from '../monitor/protocol';
import { normalizeActiveSession, normalizeHost, resolveSessionHost, type RawActiveSession, type RemoteSession } from './remoteSessions';
import type { ProjectRule } from './settings';

/** Window-local projection of the canonical CLI stream; contains no lifecycle logic. */
export class SessionPresentationStore {
  private rows = new Map<string, unknown>();
  private sequences = new Map<string, number>();
  private scopes = new Map<string, { status: 'available' | 'unavailable'; reason?: string }>();

  apply(event: SessionCliFactPayload): boolean {
    const previous = this.sequences.get(event.streamId) ?? 0;
    if (event.sequence <= previous) return false;
    this.sequences.set(event.streamId, event.sequence);
    if (event.type === 'reset') {
      for (const [rowKey, value] of this.rows) {
        if (this.scopeOf(value) === event.scope) this.rows.delete(rowKey);
      }
      for (const row of event.rows ?? []) {
        const rowKey = this.rowKeyOf(row);
        if (rowKey) this.rows.set(rowKey, row);
      }
    } else if (event.type === 'upsert') {
      const rowKey = event.rowKey || this.rowKeyOf(event.row);
      if (rowKey && event.row) this.rows.set(rowKey, event.row);
    } else if (event.type === 'remove' && event.rowKey) {
      this.rows.delete(event.rowKey);
    } else if (event.type === 'scope' && event.status) {
      this.scopes.set(event.scope, { status: event.status, ...(event.reason ? { reason: event.reason } : {}) });
    }
    return true;
  }

  sessions(): unknown[] { return [...this.rows.values()]; }
  scope(scope: string): { status: 'available' | 'unavailable'; reason?: string } | undefined {
    return this.scopes.get(scope);
  }
  clear(): void { this.rows.clear(); this.sequences.clear(); this.scopes.clear(); }

  /** Normalize the CLI stream rows for UI rendering without starting another query. */
  presentedSessions(
    localMachineId: string,
    localLabel: string,
    projectRules: ProjectRule[] = [],
    fetchedAt: number = Date.now(),
  ): RemoteSession[] {
    return this.sessions().flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const row = value as RawActiveSession & { agentType?: string; host?: string };
      const raw = {
        ...row,
        kind: row.kind || row.agentType || '',
      } as RawActiveSession;
      const machine = typeof raw.machine === 'string' ? raw.machine : row.host;
      const host = resolveSessionHost(machine, localLabel, normalizeHost(localMachineId), localLabel);
      return [normalizeActiveSession(raw, host, fetchedAt, projectRules)];
    });
  }

  /** Session identity join used by terminal hydration and fork bookkeeping. */
  terminalSessionMap(host?: string): Map<string, string> {
    const wanted = normalizeHost(host || '');
    const result = new Map<string, string>();
    for (const value of this.sessions()) {
      if (!value || typeof value !== 'object') continue;
      const row = value as { terminalId?: unknown; sessionId?: unknown; id?: unknown; machine?: unknown; host?: unknown };
      const terminalId = typeof row.terminalId === 'string' ? row.terminalId : '';
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : typeof row.id === 'string' ? row.id : '';
      const machine = normalizeHost(typeof row.machine === 'string' ? row.machine : typeof row.host === 'string' ? row.host : '');
      if (wanted && machine && wanted !== machine) continue;
      if (terminalId && sessionId) result.set(terminalId, sessionId);
    }
    return result;
  }

  private rowKeyOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const rowKey = (value as { rowKey?: unknown }).rowKey;
    return typeof rowKey === 'string' && rowKey ? rowKey : undefined;
  }

  private scopeOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const scope = (value as { sourceDevice?: unknown }).sourceDevice;
    return typeof scope === 'string' ? scope : undefined;
  }
}

/** Exactly one presentation store per extension host process. */
export const sessionPresentationStore = new SessionPresentationStore();
