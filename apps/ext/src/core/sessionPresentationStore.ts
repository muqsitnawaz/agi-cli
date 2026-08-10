import type { SessionCliFactPayload } from '../monitor/protocol';
import { normalizeActiveSession, normalizeHost, resolveSessionHost, type RawActiveSession, type RemoteSession } from './remoteSessions';
import type { ProjectRule } from './settings';

/** Window-local projection of the canonical CLI stream; contains no lifecycle logic. */
export class SessionPresentationStore {
  private rows = new Map<string, unknown>();
  private version = -1;
  private currentScope: unknown;

  apply(event: SessionCliFactPayload): boolean {
    if (event.version < this.version) return false;
    this.version = event.version;
    if (event.type === 'reset') {
      this.rows.clear();
      for (const row of event.sessions ?? []) {
        const id = this.idOf(row);
        if (id) this.rows.set(id, row);
      }
    } else if (event.type === 'upsert') {
      const id = this.idOf(event.session);
      if (id) this.rows.set(id, event.session);
    } else if (event.type === 'remove' && event.id) {
      this.rows.delete(event.id);
    } else if (event.type === 'scope') {
      this.currentScope = event.scope;
    }
    return true;
  }

  sessions(): unknown[] { return [...this.rows.values()]; }
  scope(): unknown { return this.currentScope; }
  clear(): void { this.rows.clear(); this.version = -1; this.currentScope = undefined; }

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

  private idOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const row = value as { id?: unknown; sessionId?: unknown };
    const id = row.id ?? row.sessionId;
    return typeof id === 'string' && id ? id : undefined;
  }
}

/** Exactly one presentation store per extension host process. */
export const sessionPresentationStore = new SessionPresentationStore();
