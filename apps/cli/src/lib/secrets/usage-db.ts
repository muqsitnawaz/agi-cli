/**
 * SQLite-backed usage metadata for `agents secrets`.
 *
 * A small local database at ~/.agents/secrets/secrets.db that records one
 * value-free row every time a bundle is READ (accessed/queried), IMPORTED,
 * EXPORTED, or UNLOCKED — the operational events the `view` / `list` surfaces
 * report on ("accessed 42 times, last 2h ago; last exported 3d ago"). It is the
 * queryable, per-bundle counterpart to the append-only ~/.agents/events.jsonl
 * audit log: the same access chokepoint (`emitSecretAudit`) feeds both, but this
 * store answers "how often / how recently was THIS bundle used?" without scanning
 * the whole event stream.
 *
 * Contract, mirroring the audit log: NEVER a secret value. Only metadata — the
 * bundle name, the event kind, key counts, the resolving agent/host, a status.
 *
 * Every write is best-effort: a failure here (missing runtime SQLite, a locked
 * db, a read-only fs) is swallowed so usage telemetry can never break secret
 * resolution. Set AGENTS_NO_USAGE_TRACK=1 to disable recording entirely (used by
 * tests and by callers that must stay perfectly silent).
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from '../sqlite.js';
import { getSecretsDbPath } from '../state.js';

/** The four operational events a bundle accrues over its life. */
export type SecretUsageEvent = 'access' | 'import' | 'export' | 'unlock';

/** All event kinds, in the order `view` prints them. */
export const SECRET_USAGE_EVENTS: readonly SecretUsageEvent[] = [
  'access',
  'unlock',
  'import',
  'export',
] as const;

export interface RecordUsageParams {
  /** Bundle the event applies to (required — usage is always per-bundle). */
  bundle: string;
  /** What happened. */
  event: SecretUsageEvent;
  /** Resolving agent/harness identity, when known (`*` = a global grant). */
  agent?: string;
  /** Remote host the value was pulled from / pushed to, when applicable. */
  host?: string;
  /** Free-form origin label, e.g. 'agent', 'reveal', 'ssh', '1password'. */
  source?: string;
  /** Outcome; defaults to 'success'. */
  status?: 'success' | 'error';
  /** How many keys the event touched (names only are ever known here). */
  keyCount?: number;
}

/** One event kind's rollup for a bundle. */
export interface UsageStat {
  count: number;
  /** ISO 8601 timestamp of the most recent occurrence, or null if never. */
  last: string | null;
}

/** Per-bundle usage summary for the `view` / `list` surfaces. */
export interface BundleUsageSummary {
  bundle: string;
  /** Every recorded event, all kinds. */
  total: number;
  /** Rollup per event kind (every kind present, zeroed when unused). */
  events: Record<SecretUsageEvent, UsageStat>;
  /** Most recent event across all kinds, or null. */
  lastUsedAt: string | null;
  /** Earliest event across all kinds, or null. */
  firstUsedAt: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  bundle TEXT NOT NULL,
  event TEXT NOT NULL,
  agent TEXT,
  host TEXT,
  source TEXT,
  status TEXT,
  key_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_bundle ON usage_events(bundle);
CREATE INDEX IF NOT EXISTS idx_usage_bundle_event ON usage_events(bundle, event);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts DESC);
`;

// Cached handle keyed by the resolved path, so a test that redirects
// AGENTS_SECRETS_DB to a fresh temp file transparently reopens instead of
// reusing a stale handle pointed at the previous path.
let cached: { path: string; db: Database.Database } | null = null;

function emptyEvents(): Record<SecretUsageEvent, UsageStat> {
  return {
    access: { count: 0, last: null },
    unlock: { count: 0, last: null },
    import: { count: 0, last: null },
    export: { count: 0, last: null },
  };
}

/**
 * Open (creating if needed) the usage DB, returning null on any failure so
 * every caller degrades to a no-op rather than throwing into secret resolution.
 */
function open(): Database.Database | null {
  const dbPath = getSecretsDbPath();
  if (cached && cached.path === dbPath) return cached.db;
  if (cached) {
    try { cached.db.close(); } catch { /* ignore */ }
    cached = null;
  }
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    // WAL + a busy timeout so concurrent agent runs writing usage rows don't
    // fail each other under load; every write is still best-effort besides.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 2000');
    db.exec(SCHEMA);
    cached = { path: dbPath, db };
    return db;
  } catch {
    return null;
  }
}

/**
 * Record one usage event. Best-effort and value-free — swallows every error and
 * honors AGENTS_NO_USAGE_TRACK so telemetry never blocks or slows a read. Rows
 * with an empty bundle name are ignored (usage is per-bundle by definition).
 */
export function recordSecretUsage(p: RecordUsageParams): void {
  if (process.env.AGENTS_NO_USAGE_TRACK) return;
  if (!p.bundle) return;
  const db = open();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO usage_events (ts, bundle, event, agent, host, source, status, key_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      p.bundle,
      p.event,
      p.agent ?? null,
      p.host ?? null,
      p.source ?? null,
      p.status ?? 'success',
      p.keyCount ?? null,
    );
  } catch {
    // Telemetry must never break secret resolution.
  }
}

interface RollupRow { event: string; n: number; last: string | null; first: string | null }

function toSummary(bundle: string, rows: RollupRow[]): BundleUsageSummary {
  const events = emptyEvents();
  let total = 0;
  let lastUsedAt: string | null = null;
  let firstUsedAt: string | null = null;
  for (const r of rows) {
    if (r.event in events) {
      const stat = events[r.event as SecretUsageEvent];
      stat.count = r.n;
      stat.last = r.last;
    }
    total += r.n;
    if (r.last && (!lastUsedAt || r.last > lastUsedAt)) lastUsedAt = r.last;
    if (r.first && (!firstUsedAt || r.first < firstUsedAt)) firstUsedAt = r.first;
  }
  return { bundle, total, events, lastUsedAt, firstUsedAt };
}

/**
 * Usage summary for one bundle, or undefined when nothing has ever been
 * recorded (or the DB is unavailable). Never throws.
 */
export function getBundleUsage(bundle: string): BundleUsageSummary | undefined {
  const db = open();
  if (!db) return undefined;
  try {
    const rows = db
      .prepare(
        `SELECT event, COUNT(*) AS n, MAX(ts) AS last, MIN(ts) AS first
           FROM usage_events WHERE bundle = ? GROUP BY event`,
      )
      .all(bundle) as RollupRow[];
    if (rows.length === 0) return undefined;
    return toSummary(bundle, rows);
  } catch {
    return undefined;
  }
}

/**
 * Usage summaries for every bundle that has any recorded event, keyed by bundle
 * name. Powers `secrets list --sort uses|used`. Empty map when the DB is
 * unavailable or has no rows. Never throws.
 */
export function getAllBundleUsage(): Map<string, BundleUsageSummary> {
  const out = new Map<string, BundleUsageSummary>();
  const db = open();
  if (!db) return out;
  try {
    const rows = db
      .prepare(
        `SELECT bundle, event, COUNT(*) AS n, MAX(ts) AS last, MIN(ts) AS first
           FROM usage_events GROUP BY bundle, event`,
      )
      .all() as (RollupRow & { bundle: string })[];
    const byBundle = new Map<string, RollupRow[]>();
    for (const r of rows) {
      const list = byBundle.get(r.bundle) ?? [];
      list.push(r);
      byBundle.set(r.bundle, list);
    }
    for (const [bundle, list] of byBundle) out.set(bundle, toSummary(bundle, list));
    return out;
  } catch {
    return out;
  }
}

/** Close the cached handle. Used by tests between temp-db swaps. */
export function closeSecretsUsageDb(): void {
  if (cached) {
    try { cached.db.close(); } catch { /* ignore */ }
    cached = null;
  }
}
