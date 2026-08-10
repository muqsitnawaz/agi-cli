/**
 * Per-box hosted webhook receivers: config + daemon host (RUSH-2548).
 *
 * `~/.agents/daemon/webhooks.yaml` declares which signed webhook receivers THIS
 * box hosts — bundle, local port, rate limit, and an optional public Tailscale
 * Funnel port. The daemon's `webhook-receiver` service reads it and binds one
 * receiver per entry, drawing each receiver's signing secret from the broker /
 * machine-local file store (no `AGENTS_SECRETS_PASSPHRASE`, no `nohup`). An
 * absent or empty file hosts nothing, so an unconfigured box binds nothing.
 *
 * This is per-box operational state (a public receiver runs on exactly one box),
 * so it is deliberately NOT part of the fleet-synced device config — it mirrors
 * `services.yaml` / daemon-services.ts, not `agents config`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { exec } from 'child_process';
import type { Server } from 'http';
import { getDaemonConfigDir, getRuntimeStateDir } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { readAndResolveBundleEnv } from './secrets/bundles.js';
import { startWebhookServer, createFileDeliveryStore, type WebhookSecrets } from './triggers/webhook.js';
import { buildFunnelUpCommand } from './funnel.js';

export const DEFAULT_WEBHOOK_PORT = 8787;
export const DEFAULT_WEBHOOK_RATE_LIMIT = 60;

/** Optional public exposure for a hosted receiver via Tailscale Funnel. */
export interface HostedReceiverFunnel {
  /** Public HTTPS port (Funnel allows 443 / 8443 / 10000). */
  publicPort: number;
}

/** One receiver this box hosts. */
export interface HostedReceiverConfig {
  /** Secrets bundle holding GITHUB_WEBHOOK_SECRET and/or LINEAR_WEBHOOK_SECRET. */
  bundle: string;
  /** Local bind port (default 8787). */
  port?: number;
  /** Accepted deliveries per source per minute (default 60). */
  rateLimit?: number;
  /** Public Funnel exposure; omit to bind localhost only. */
  funnel?: HostedReceiverFunnel;
}

export interface DaemonWebhooksConfig {
  receivers: HostedReceiverConfig[];
}

/** Path to `~/.agents/daemon/webhooks.yaml`. */
export function getDaemonWebhooksConfigPath(): string {
  return path.join(getDaemonConfigDir(), 'webhooks.yaml');
}

function coerceReceiver(item: unknown): HostedReceiverConfig | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.bundle !== 'string' || obj.bundle.length === 0) return null;
  const rc: HostedReceiverConfig = { bundle: obj.bundle };
  if (typeof obj.port === 'number' && Number.isInteger(obj.port) && obj.port > 0) rc.port = obj.port;
  if (typeof obj.rateLimit === 'number' && Number.isInteger(obj.rateLimit) && obj.rateLimit > 0) rc.rateLimit = obj.rateLimit;
  const funnel = obj.funnel as Record<string, unknown> | undefined;
  if (funnel && typeof funnel === 'object' && typeof funnel.publicPort === 'number' && funnel.publicPort > 0) {
    rc.funnel = { publicPort: funnel.publicPort };
  }
  return rc;
}

/**
 * Read the hosted-receivers config. A missing or malformed file yields an empty
 * receiver list — never throws — so a box with no config hosts nothing.
 */
export function readDaemonWebhooksConfig(): DaemonWebhooksConfig {
  try {
    const raw = fs.readFileSync(getDaemonWebhooksConfigPath(), 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown> | null;
    const list = parsed && Array.isArray(parsed.receivers) ? parsed.receivers : [];
    const receivers = list.map(coerceReceiver).filter((r): r is HostedReceiverConfig => r !== null);
    return { receivers };
  } catch {
    return { receivers: [] };
  }
}

/** Write the hosted-receivers config, creating the daemon config dir if needed. */
export function writeDaemonWebhooksConfig(cfg: DaemonWebhooksConfig): void {
  fs.mkdirSync(getDaemonConfigDir(), { recursive: true });
  const out = yaml.stringify({ receivers: cfg.receivers }, { sortMapEntries: false });
  atomicWriteFileSync(getDaemonWebhooksConfigPath(), out, 'utf-8');
}

/**
 * Resolve a receiver's signing secrets from its bundle. Reads `agentOnly` (no
 * Touch ID — the daemon is a background service, SEC-13): a broker-held or
 * file-store bundle resolves silently; a locked bundle THROWS the actionable
 * unlock message, which fails the receiver LOUD rather than binding with no
 * verifiable signature. Throws when neither webhook secret is present.
 */
export function resolveReceiverSecrets(bundle: string): WebhookSecrets {
  const { env } = readAndResolveBundleEnv(bundle, { caller: 'daemon webhook-receiver', agentOnly: true });
  const secrets: WebhookSecrets = {};
  if (env.GITHUB_WEBHOOK_SECRET) secrets.github = env.GITHUB_WEBHOOK_SECRET;
  if (env.LINEAR_WEBHOOK_SECRET) secrets.linear = env.LINEAR_WEBHOOK_SECRET;
  if (!secrets.github && !secrets.linear) {
    throw new Error(`bundle '${bundle}' has neither GITHUB_WEBHOOK_SECRET nor LINEAR_WEBHOOK_SECRET`);
  }
  return secrets;
}

export interface HostedWebhookReceivers {
  /** Number of receivers actually bound. */
  count: number;
  /** Stop every hosted receiver. Idempotent. */
  close(): Promise<void>;
}

type Logger = (level: string, message: string) => void;

/** Best-effort funnel reconcile: bring the declared public port up, log on failure. */
function reconcileFunnel(publicPort: number, localPort: number, log: Logger): void {
  let command: string;
  try {
    command = buildFunnelUpCommand(publicPort, localPort);
  } catch (err) {
    log('WARN', `webhook funnel skipped (port ${publicPort}): ${(err as Error).message}`);
    return;
  }
  exec(command, (err) => {
    if (err) {
      log('WARN', `webhook funnel reconcile failed (public ${publicPort} -> localhost:${localPort}); binding localhost only: ${err.message}`);
    } else {
      log('INFO', `webhook funnel up: public ${publicPort} -> localhost:${localPort}`);
    }
  });
}

/**
 * Start every receiver declared in `webhooks.yaml`. A receiver whose secret is
 * unreadable (locked bundle, no webhook secret) is skipped with a loud WARN and
 * does not take the others down. Returns a handle that stops them all.
 */
export function startHostedWebhookReceivers(opts: { log: Logger }): HostedWebhookReceivers {
  const { log } = opts;
  const { receivers } = readDaemonWebhooksConfig();
  const servers: Server[] = [];

  for (const receiver of receivers) {
    const port = receiver.port ?? DEFAULT_WEBHOOK_PORT;
    let secrets: WebhookSecrets;
    try {
      secrets = resolveReceiverSecrets(receiver.bundle);
    } catch (err) {
      log('WARN', `webhook receiver on :${port} skipped: ${(err as Error).message}`);
      continue;
    }
    try {
      const server = startWebhookServer({
        host: '127.0.0.1',
        port,
        secrets,
        rateLimitPerMinute: receiver.rateLimit ?? DEFAULT_WEBHOOK_RATE_LIMIT,
        // Per-port durable delivery dedup so replays survive a daemon restart and
        // two receivers on distinct ports never share a dedup ledger.
        deliveryStore: createFileDeliveryStore(
          path.join(getRuntimeStateDir(), 'webhook', `deliveries-${port}.json`),
        ),
        onDelivery: (webhook, fired, handlers) => {
          const parts: string[] = [];
          if (fired.length) parts.push(`routines ${fired.map((f) => f.jobName).join(', ')}`);
          if (handlers.length) parts.push(`handlers ${handlers.map((h) => h.handlerName).join(', ')}`);
          log('INFO', `webhook ${webhook.source}:${webhook.event} ${parts.length ? `fired ${parts.join('; ')}` : 'no match'}`);
        },
      });
      servers.push(server);
      log('INFO', `webhook receiver bound on 127.0.0.1:${port} (bundle ${receiver.bundle})`);
      if (receiver.funnel) reconcileFunnel(receiver.funnel.publicPort, port, log);
    } catch (err) {
      log('WARN', `webhook receiver on :${port} failed to bind: ${(err as Error).message}`);
    }
  }

  return {
    count: servers.length,
    close: () =>
      Promise.all(
        servers.map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      ).then(() => undefined),
  };
}
