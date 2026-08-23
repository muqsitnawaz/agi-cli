/**
 * CLI-owned pull-request status source (Track B of the feed-driven Needs You
 * feature). AGI EXT used to run its own `gh pr view` poll with a TTL cache in
 * `apps/ext/src/vscode/prBoard.vscode.ts`; that made the extension a second
 * GitHub poller and a second authority on "does this PR need a human". This
 * module moves that sourcing into the CLI: the feed watch stream refreshes PR
 * status on a bounded TTL and supplies it to BOTH
 *   1. feed attention — as the {@link PullRequestAttentionSignal} that
 *      `reconcileAttention` already accepts, so an open PR needing review/merge
 *      becomes a Needs-You item, and
 *   2. a PR-board projection — the {@link PrBoardRow} the extension renders,
 *      with the same `readyToMerge` verdict its old pure parser computed.
 *
 * The parse is pure and the `gh` runner is injectable, so the verdict rules and
 * the TTL are unit-tested without a live GitHub. The verdict mirrors the
 * extension's retired pure parser (`apps/ext/src/core/prBoard.ts`) and the CLI's
 * own CI-green rule ({@link isCiGreen}) so the board reads identically after the
 * sourcing moved.
 */
import { ghExec } from '../github/pr-mergeable.js';
import { isCiGreen } from '../github/pr-verdict.js';
import type { PullRequestAttentionSignal } from './attention.js';

// Re-exported so consumers of the PR source get the reconciler's signal type
// from one place without also importing attention.js.
export type { PullRequestAttentionSignal } from './attention.js';

/** The `gh pr view --json` field set the board + attention signal need. */
export const PR_STATUS_FIELDS =
  'number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup';

/** Default bounded TTL for a PR-status refresh, matching the extension's old `PR_TTL_MS`. */
export const PR_STATUS_TTL_MS = 45_000;

export type PrCi = 'passing' | 'failing' | 'pending' | 'none';
export type PrReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;
export type PrMergeable = 'mergeable' | 'conflicting' | 'unknown';

/** One PR-board row — the projection AGI EXT renders in place of its own gh poll. */
export interface PrBoardRow {
  url: string;
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  ci: PrCi;
  review: PrReviewDecision;
  mergeable: PrMergeable;
  /**
   * Open, not draft, approved, CI not red/running, and no merge conflict — the
   * board's Merge button renders only when this is true. Mirrors
   * `apps/ext/src/core/prBoard.ts`'s `readyToMerge`.
   */
  readyToMerge: boolean;
}

/** gh `statusCheckRollup` rows: CheckRun {status, conclusion} or StatusContext {state}. */
interface RollupRow {
  status?: string;
  conclusion?: string;
  state?: string;
}

/** Terminal, failure-class check conclusions. */
const CI_FAILING = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

/** Fold one rollup row to its effective, uppercased conclusion/state. */
function rollupState(row: RollupRow): string {
  const status = (row.status || '').toUpperCase();
  if (status && status !== 'COMPLETED') return 'PENDING';
  const conclusion = (row.conclusion || '').toUpperCase();
  if (conclusion) return conclusion;
  return (row.state || '').toUpperCase();
}

/** Aggregate a `statusCheckRollup` into one CI verdict. Empty rollup = `none`. */
export function aggregateRollup(rollup: readonly RollupRow[] | null | undefined): PrCi {
  const rows = rollup ?? [];
  if (rows.length === 0) return 'none';
  const states = rows.map(rollupState);
  if (states.some((s) => CI_FAILING.has(s))) return 'failing';
  // isCiGreen: every check is SUCCESS/NEUTRAL/SKIPPED (anything else is pending).
  if (isCiGreen(rows.map((r) => ({ state: rollupState(r) })))) return 'passing';
  return 'pending';
}

/**
 * Parse the stdout of `gh pr view <url> --json <PR_STATUS_FIELDS>` into a board
 * row. Returns `null` on any parse failure, so a bad `gh` result never
 * fabricates a row (the extension parser's fail-closed contract).
 */
export function parsePrStatus(url: string, stdout: string): PrBoardRow | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const d = JSON.parse(trimmed) as Record<string, unknown>;
    if (!d || typeof d !== 'object' || typeof d.number !== 'number') return null;
    const rawState = String(d.state ?? '').toUpperCase();
    const state: PrBoardRow['state'] =
      rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : 'open';
    const rawReview = String(d.reviewDecision ?? '').toUpperCase();
    const review: PrReviewDecision =
      rawReview === 'APPROVED' ? 'approved'
        : rawReview === 'CHANGES_REQUESTED' ? 'changes_requested'
          : rawReview === 'REVIEW_REQUIRED' ? 'review_required'
            : null;
    const rawMergeable = String(d.mergeable ?? '').toUpperCase();
    const mergeable: PrMergeable =
      rawMergeable === 'MERGEABLE' ? 'mergeable'
        : rawMergeable === 'CONFLICTING' ? 'conflicting'
          : 'unknown';
    const rollup = Array.isArray(d.statusCheckRollup) ? (d.statusCheckRollup as RollupRow[]) : [];
    const ci = aggregateRollup(rollup);
    const isDraft = d.isDraft === true;
    const readyToMerge =
      state === 'open' && !isDraft && review === 'approved'
      && ci !== 'failing' && ci !== 'pending' && mergeable === 'mergeable';
    return {
      url,
      number: d.number,
      title: typeof d.title === 'string' ? d.title : '',
      state,
      isDraft,
      ci,
      review,
      mergeable,
      readyToMerge,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a PR needs an operator decision: it is open, not a draft, and either
 * still awaits review (not yet approved) or is approved AND ready to merge (the
 * merge is the pending human action). An approved PR whose CI is red/pending is
 * NOT a review item — that failure surfaces through the session lifecycle, not a
 * duplicate PR card.
 */
export function prNeedsHuman(row: PrBoardRow): boolean {
  if (row.state !== 'open' || row.isDraft) return false;
  if (row.review !== 'approved') return true;
  return row.readyToMerge;
}

/** Map a board row to the reconciler's {@link PullRequestAttentionSignal}. */
export function toAttentionSignal(row: PrBoardRow): PullRequestAttentionSignal {
  return {
    number: row.number,
    title: row.title || undefined,
    url: row.url,
    needsHuman: prNeedsHuman(row),
    reviewDecision: row.review ?? undefined,
    mergeable: row.mergeable,
    state: row.state,
    isDraft: row.isDraft,
  };
}

interface CacheEntry {
  row: PrBoardRow | null;
  fetchedAt: number;
}

export interface PrStatusSourceOptions {
  /** Bounded TTL before a cached row is re-fetched. */
  ttlMs?: number;
  /** Injectable `gh` runner (returns stdout). Defaults to {@link ghExec}. */
  run?: (args: string[]) => Promise<string>;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * A bounded-TTL PR-status source. One instance per feed-watch process caches
 * each PR url so a long-lived stream re-queries GitHub at most once per TTL per
 * PR, never once per emit. `refresh` fetches through the cache; `get` reads the
 * cache without a fetch (for a synchronous snapshot).
 */
export class PrStatusSource {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly run: (args: string[]) => Promise<string>;
  private readonly now: () => number;

  constructor(options: PrStatusSourceOptions = {}) {
    this.ttlMs = options.ttlMs ?? PR_STATUS_TTL_MS;
    this.run = options.run ?? ghExec;
    this.now = options.now ?? Date.now;
  }

  /** Cached board row for a url without fetching (undefined if never fetched). */
  get(url: string): PrBoardRow | null | undefined {
    return this.cache.get(url)?.row;
  }

  /**
   * Fetch (or return cached, if within TTL) the board row for a PR url. A `gh`
   * failure caches `null` for the TTL rather than hammering a broken auth every
   * emit — the board simply shows no row for that PR until the TTL lapses.
   */
  async refresh(url: string): Promise<PrBoardRow | null> {
    const cached = this.cache.get(url);
    const now = this.now();
    if (cached && now - cached.fetchedAt < this.ttlMs) return cached.row;
    let row: PrBoardRow | null = null;
    try {
      const stdout = await this.run(['pr', 'view', url, '--json', PR_STATUS_FIELDS]);
      row = parsePrStatus(url, stdout);
    } catch {
      row = null;
    }
    this.cache.set(url, { row, fetchedAt: now });
    return row;
  }
}
