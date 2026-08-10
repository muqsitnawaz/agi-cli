import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createInterface } from 'readline';

export type SessionCliEvent =
  | { version: number; type: 'reset'; sessions: unknown[] }
  | { version: number; type: 'upsert'; session: unknown }
  | { version: number; type: 'remove'; id: string }
  | { version: number; type: 'scope'; scope: unknown }
  | { version: number; type: 'heartbeat'; ts?: number };

export interface SessionCliStreamOptions {
  emit: (event: SessionCliEvent) => void;
  onError?: (message: string) => void;
  spawnWatch?: () => ChildProcessWithoutNullStreams;
}

/** Owns the single long-lived CLI session stream for the elected monitor. */
export class SessionCliStream {
  private child?: ChildProcessWithoutNullStreams;

  constructor(private readonly options: SessionCliStreamOptions) {}

  start(): void {
    if (this.child) return;
    const child = this.options.spawnWatch?.() ?? spawn(
      'agents',
      ['sessions', 'watch', '--json'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line) as SessionCliEvent;
        if (event && Number.isInteger(event.version) && typeof event.type === 'string') {
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
      if (code !== 0) {
        this.options.onError?.(
          stderr.trim() || 'This version of agents-cli does not support sessions watch --json. Upgrade agents-cli.',
        );
      }
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
