import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createInterface } from 'readline';
import { bootstrapPath, resolveAgentsBin } from '../core/agentsBin';

import type { SessionCliFactPayload as SessionCliEvent } from './protocol';
export type { SessionCliEvent };

export interface SessionCliStreamOptions {
  emit: (event: SessionCliEvent) => void;
  onError?: (message: string) => void;
  spawnWatch?: () => ChildProcessWithoutNullStreams;
}

/** Current CLI-owned rows retained only so a late follower can receive a reset. */
export class SessionCliReplay {
  private replaySequence = 0;
  private readonly scopes = new Map<string, {
    rows: Map<string, unknown>;
    capturedAt: number;
    status?: 'available' | 'unavailable';
    reason?: string;
  }>();

  ingest(event: SessionCliEvent): void {
    const current = this.scopes.get(event.scope) ?? {
      rows: new Map<string, unknown>(),
      capturedAt: event.capturedAt,
    };
    current.capturedAt = event.capturedAt;
    if (event.type === 'reset') {
      current.rows = new Map((event.rows ?? []).flatMap((row) => {
        const rowKey = row && typeof row === 'object' ? (row as { rowKey?: unknown }).rowKey : undefined;
        return typeof rowKey === 'string' ? [[rowKey, row] as const] : [];
      }));
    } else if (event.type === 'upsert' && event.rowKey && event.row) {
      current.rows.set(event.rowKey, event.row);
    } else if (event.type === 'remove' && event.rowKey) {
      current.rows.delete(event.rowKey);
    } else if (event.type === 'scope' && event.status) {
      current.status = event.status;
      current.reason = event.reason;
    }
    this.scopes.set(event.scope, current);
  }

  envelopes(clientKey: string): SessionCliEvent[] {
    const events: SessionCliEvent[] = [];
    for (const [scope, current] of this.scopes) {
      const streamId = `replay:${clientKey}:${scope}:${++this.replaySequence}`;
      events.push({
        version: 1, type: 'reset', streamId, sequence: 1,
        capturedAt: current.capturedAt, scope, rows: [...current.rows.values()],
      });
      if (current.status) {
        events.push({
          version: 1, type: 'scope', streamId, sequence: 2,
          capturedAt: current.capturedAt, scope, status: current.status,
          ...(current.reason ? { reason: current.reason } : {}),
        });
      }
    }
    return events;
  }
}

/** Owns the single long-lived CLI session stream for the elected monitor. */
export class SessionCliStream {
  private child?: ChildProcessWithoutNullStreams;
  private running = false;

  constructor(private readonly options: SessionCliStreamOptions) {}

  start(): void {
    if (this.child || this.running) return;
    this.running = true;
    if (this.options.spawnWatch) {
      this.attach(this.options.spawnWatch());
      return;
    }
    void resolveAgentsBin().then((bin) => {
      if (!this.running) return;
      const augmented = bootstrapPath(bin);
      this.attach(spawn(bin, ['sessions', 'watch', '--json'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${augmented}:${process.env.PATH ?? ''}` },
      }));
    }).catch((error) => {
      this.running = false;
      this.options.onError?.(error instanceof Error ? error.message : String(error));
    });
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    if (!this.running) { child.kill(); return; }
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line) as SessionCliEvent;
        if (event?.version === 1 && typeof event.streamId === 'string'
          && Number.isInteger(event.sequence) && typeof event.type === 'string') {
          this.options.emit(event);
        }
      } catch {
        this.options.onError?.(`agents sessions watch emitted invalid JSON: ${line.slice(0, 160)}`);
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('exit', (code) => {
      this.child = undefined;
      this.running = false;
      if (code !== 0) {
        this.options.onError?.(
          stderr.trim() || 'This version of agents-cli does not support sessions watch --json. Upgrade agents-cli.',
        );
      }
    });
  }

  stop(): void {
    this.running = false;
    this.child?.kill();
    this.child = undefined;
  }
}
