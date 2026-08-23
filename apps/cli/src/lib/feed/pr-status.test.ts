import { describe, it, expect } from 'vitest';
import {
  parsePrStatus,
  aggregateRollup,
  prNeedsHuman,
  toAttentionSignal,
  PrStatusSource,
  PR_STATUS_FIELDS,
  type PrBoardRow,
} from './pr-status.js';

function ghJson(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

describe('aggregateRollup', () => {
  it('an empty rollup is `none` (a PR with no checks is not red)', () => {
    expect(aggregateRollup([])).toBe('none');
    expect(aggregateRollup(undefined)).toBe('none');
  });

  it('any failure-class conclusion is `failing`', () => {
    expect(aggregateRollup([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('failing');
    expect(aggregateRollup([{ conclusion: 'TIMED_OUT' }])).toBe('failing');
  });

  it('an in-progress check (status != COMPLETED) is `pending`', () => {
    expect(aggregateRollup([{ status: 'IN_PROGRESS' }])).toBe('pending');
    expect(aggregateRollup([{ conclusion: 'SUCCESS' }, { status: 'QUEUED' }])).toBe('pending');
  });

  it('all success/neutral/skipped is `passing`', () => {
    expect(aggregateRollup([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }])).toBe('passing');
  });
});

describe('parsePrStatus', () => {
  it('returns null on empty or malformed stdout (never fabricates a row)', () => {
    expect(parsePrStatus('https://x/1', '')).toBeNull();
    expect(parsePrStatus('https://x/1', 'not json')).toBeNull();
    expect(parsePrStatus('https://x/1', '{"title":"no number"}')).toBeNull();
  });

  it('parses an open, approved, green, mergeable PR as readyToMerge', () => {
    const row = parsePrStatus('https://x/7', ghJson({
      number: 7,
      title: 'Feat X',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'APPROVED',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    }));
    expect(row).toMatchObject({
      number: 7,
      state: 'open',
      review: 'approved',
      mergeable: 'mergeable',
      ci: 'passing',
      readyToMerge: true,
    });
  });

  it('a draft is never readyToMerge even when approved+green', () => {
    const row = parsePrStatus('https://x/8', ghJson({
      number: 8, state: 'OPEN', isDraft: true, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    }));
    expect(row?.readyToMerge).toBe(false);
  });

  it('a conflicting or red PR is not readyToMerge', () => {
    const conflicting = parsePrStatus('https://x/9', ghJson({
      number: 9, state: 'OPEN', reviewDecision: 'APPROVED', mergeable: 'CONFLICTING',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    }));
    expect(conflicting?.readyToMerge).toBe(false);
    const red = parsePrStatus('https://x/10', ghJson({
      number: 10, state: 'OPEN', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'FAILURE' }],
    }));
    expect(red?.readyToMerge).toBe(false);
  });
});

describe('prNeedsHuman', () => {
  const base: PrBoardRow = {
    url: 'https://x/1', number: 1, title: 't', state: 'open', isDraft: false,
    ci: 'passing', review: 'approved', mergeable: 'mergeable', readyToMerge: true,
  };
  it('an unreviewed open PR needs a human (review it)', () => {
    expect(prNeedsHuman({ ...base, review: 'review_required', readyToMerge: false })).toBe(true);
    expect(prNeedsHuman({ ...base, review: null, readyToMerge: false })).toBe(true);
    expect(prNeedsHuman({ ...base, review: 'changes_requested', readyToMerge: false })).toBe(true);
  });
  it('an approved + ready PR needs a human (merge it)', () => {
    expect(prNeedsHuman(base)).toBe(true);
  });
  it('an approved PR that is NOT ready (red/pending CI) needs no PR card', () => {
    expect(prNeedsHuman({ ...base, ci: 'failing', readyToMerge: false })).toBe(false);
  });
  it('draft / merged / closed never needs a human', () => {
    expect(prNeedsHuman({ ...base, isDraft: true })).toBe(false);
    expect(prNeedsHuman({ ...base, state: 'merged' })).toBe(false);
    expect(prNeedsHuman({ ...base, state: 'closed' })).toBe(false);
  });
});

describe('toAttentionSignal', () => {
  it('maps a board row to the reconciler signal', () => {
    const sig = toAttentionSignal({
      url: 'https://x/3', number: 3, title: 'T', state: 'open', isDraft: false,
      ci: 'passing', review: 'review_required', mergeable: 'unknown', readyToMerge: false,
    });
    expect(sig).toEqual({
      number: 3, title: 'T', url: 'https://x/3', needsHuman: true,
      reviewDecision: 'review_required', mergeable: 'unknown', state: 'open', isDraft: false,
    });
  });
});

describe('PrStatusSource TTL cache', () => {
  it('fetches once, serves the cache within the TTL, and re-fetches after it', async () => {
    let calls = 0;
    let clock = 1_000;
    const run = async (args: string[]) => {
      // Prove the source dials the exact `gh pr view <url> --json <fields>`.
      expect(args).toEqual(['pr', 'view', 'https://x/1', '--json', PR_STATUS_FIELDS]);
      calls += 1;
      return ghJson({ number: 1, state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'UNKNOWN', statusCheckRollup: [] });
    };
    const source = new PrStatusSource({ ttlMs: 100, run, now: () => clock });

    const a = await source.refresh('https://x/1');
    expect(a?.number).toBe(1);
    expect(calls).toBe(1);

    clock = 1_050; // within TTL
    await source.refresh('https://x/1');
    expect(calls).toBe(1); // served from cache

    clock = 1_200; // past TTL
    await source.refresh('https://x/1');
    expect(calls).toBe(2); // re-fetched
  });

  it('caches null on a gh failure so a broken auth is not hammered every emit', async () => {
    let calls = 0;
    const run = async () => { calls += 1; throw new Error('gh: not authenticated'); };
    const source = new PrStatusSource({ ttlMs: 10_000, run, now: () => 5_000 });
    expect(await source.refresh('https://x/2')).toBeNull();
    expect(await source.refresh('https://x/2')).toBeNull();
    expect(calls).toBe(1);
    expect(source.get('https://x/2')).toBeNull();
  });
});
