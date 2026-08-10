import type { SessionCliFactPayload } from '../monitor/protocol';

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

  private idOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const row = value as { id?: unknown; sessionId?: unknown };
    const id = row.id ?? row.sessionId;
    return typeof id === 'string' && id ? id : undefined;
  }
}
