/**
 * Local secrets activity database at ~/.agents/secrets/secrets.db.
 *
 * Tracks the lifecycle events that matter for a credential — when a bundle was
 * created, imported, exported, viewed, and (most importantly) accessed for
 * injection into a run — plus per-bundle aggregates (use count, last use) that
 * power `agents secrets list --sort used|freq` and the activity section of
 * `agents secrets view`. The events.jsonl audit log (lib/secrets/audit.ts)
 * records security-relevant READS for the audit surface; this DB records
 * metadata-only usage history for operators, mirroring how sessions.db indexes
 * session metadata. Secret values are never stored here — bundle names, event
 * kinds, and human-readable details only.
 *
 * Like stampLastUsed, every write is best-effort: activity tracking must never
 * break secret resolution, so all record paths swallow errors, and
 * AGENTS_NO_USAGE_TRACK=1 disables recording entirely (used by tests).
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from '../sqlite.js';
import { getUserSecretsDir } from '../state.js';

/** Current schema version; bump when migrations are added. */
export const SECRETS_ACTIVITY_SCHEMA_VERSION = 1;

/** The lifecycle events recorded per bundle. */
export type SecretActivityKind = 'create' | 'import' | 'export' | 'view' | 'access';

/** A single recorded activity event. */
export interface SecretActivityEvent {
  id: number;
  ts: string;
  bundle: string;
  kind: SecretActivityKind;
  detail: string | null;
  agent: string | null;
  source: string | null;
}

/** Per-bundle usage aggregates driving `--sort freq` and the view summary. */
export interface BundleUsageStats {
  bundle: string;
  useCount: number;
  lastUsedAt: string | null;
}

/** Events older than this are pruned on first open so the log stays bounded. */
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  bundle TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  agent TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_bundle_ts ON events(bundle, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

CREATE TABLE IF NOT EXISTS bundle_stats (
  bundle TEXT PRIMARY KEY,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

let dbInstance: Database.Database | null = null;
let dbPathOverride: string | null = null;

/** Path to the activity DB. Honors AGENTS_SECRETS_DB_PATH (tests, sandboxes). */
export function secretsActivityDbPath(): string {
  if (process.env.AGENTS_SECRETS_DB_PATH) return process.env.AGENTS_SECRETS_DB_PATH;
  if (dbPathOverride) return dbPathOverride;
  return path.join(getUserSecretsDir(), 'secrets.db');
}

/** Open (or return the cached) activity database, creating the schema as needed. */
function getDB(): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = secretsActivityDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  // Multiple agent processes record activity concurrently; wait rather than fail.
  db.pragma('busy_timeout = 30000');
  db.exec(SCHEMA);
  db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)`).run(
    String(SECRETS_ACTIVITY_SCHEMA_VERSION),
  );
  // Bounded retention: events are a usage history, not a compliance log (that is
  // events.jsonl). Runs once per process, cheap on a 90-day window.
  db.prepare(`DELETE FROM events WHERE ts < ?`).run(
    new Date(Date.now() - EVENT_RETENTION_MS).toISOString(),
  );
  dbInstance = db;
  return db;
}

/** Parameters for recordSecretActivity. */
export interface RecordActivityParams {
  bundle: string;
  kind: SecretActivityKind;
  /** Human-readable context, e.g. "--from .env" or the caller label. Never a value. */
  detail?: string;
  /** Harness name when the activity was performed on behalf of an agent. */
  agent?: string;
  /** Where the activity happened, e.g. "exec", "run --secrets", "reveal". */
  source?: string;
}

/**
 * Record one activity event. `access` events also bump the bundle's use_count
 * and last_used_at aggregates (those drive `--sort freq`); the other kinds are
 * history-only. Never throws — telemetry must not break the calling flow.
 */
export function recordSecretActivity(p: RecordActivityParams): void {
  if (process.env.AGENTS_NO_USAGE_TRACK) return;
  try {
    const ts = new Date().toISOString();
    const db = getDB();
    db.prepare(
      `INSERT INTO events(ts, bundle, kind, detail, agent, source) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ts, p.bundle, p.kind, p.detail ?? null, p.agent ?? null, p.source ?? null);
    if (p.kind === 'access') {
      db.prepare(
        `INSERT INTO bundle_stats(bundle, use_count, last_used_at) VALUES (?, 1, ?)
         ON CONFLICT(bundle) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at`,
      ).run(p.bundle, ts);
    }
  } catch {
    // Swallow — activity tracking is never allowed to break secret flows.
  }
}

/** Usage aggregates for one bundle, or null when nothing has been recorded. */
export function getBundleUsage(name: string): BundleUsageStats | null {
  try {
    const row = getDB()
      .prepare(`SELECT bundle, use_count, last_used_at FROM bundle_stats WHERE bundle = ?`)
      .get(name) as { bundle: string; use_count: number; last_used_at: string | null } | undefined;
    if (!row) return null;
    return { bundle: row.bundle, useCount: row.use_count, lastUsedAt: row.last_used_at };
  } catch {
    return null;
  }
}

/** Usage aggregates for every recorded bundle, keyed by bundle name. */
export function listBundleUsage(): Map<string, BundleUsageStats> {
  const out = new Map<string, BundleUsageStats>();
  try {
    const rows = getDB()
      .prepare(`SELECT bundle, use_count, last_used_at FROM bundle_stats`)
      .all() as Array<{ bundle: string; use_count: number; last_used_at: string | null }>;
    for (const row of rows) {
      out.set(row.bundle, { bundle: row.bundle, useCount: row.use_count, lastUsedAt: row.last_used_at });
    }
  } catch {
    // An unreadable DB must not break `secrets list` — sort hints just go empty.
  }
  return out;
}

/** Most recent events for a bundle, newest first. */
export function getRecentBundleEvents(name: string, limit = 5): SecretActivityEvent[] {
  try {
    const rows = getDB()
      .prepare(
        `SELECT id, ts, bundle, kind, detail, agent, source FROM events
         WHERE bundle = ? ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(name, limit) as Array<{
      id: number;
      ts: string;
      bundle: string;
      kind: SecretActivityKind;
      detail: string | null;
      agent: string | null;
      source: string | null;
    }>;
    return rows;
  } catch {
    return [];
  }
}

/** Test hook: close the singleton and (optionally) point it at a temp DB. */
export function _resetSecretsActivityForTest(dbPath?: string): void {
  try {
    dbInstance?.close();
  } catch {
    /* already closed */
  }
  dbInstance = null;
  dbPathOverride = dbPath ?? null;
}
