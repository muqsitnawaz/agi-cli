import { describe, it, expect } from 'vitest';

import {
  assembleSnapshot,
  summarizeFeedBlocks,
  type SnapshotSessionRow,
} from './snapshot.js';
import type { OpenBlock } from './feed.js';
import type { ViewJsonAgent } from '../commands/view.js';

function block(partial: Partial<OpenBlock> & Pick<OpenBlock, 'blockId' | 'sessionId' | 'ts'>): OpenBlock {
  return {
    mailboxId: 'mb',
    host: 'zion',
    runtime: 'claude',
    questions: [{ text: 'ok?', options: [] }],
    ...partial,
  };
}

describe('summarizeFeedBlocks', () => {
  it('counts all open blocks and caps the row list', () => {
    const blocks = [
      block({ blockId: 'a', sessionId: 's1', ts: '2026-08-01T00:00:00Z' }),
      block({ blockId: 'b', sessionId: 's2', ts: '2026-08-02T00:00:00Z', ticket: 'RUSH-1' }),
      block({ blockId: 'c', sessionId: 's3', ts: '2026-08-03T00:00:00Z' }),
    ];
    const summary = summarizeFeedBlocks(blocks, 2);
    expect(summary.openBlocks).toBe(3);
    expect(summary.blocks).toHaveLength(2);
    // Newest first.
    expect(summary.blocks[0].blockId).toBe('c');
    expect(summary.blocks[1].blockId).toBe('b');
    expect(summary.blocks[1].ticket).toBe('RUSH-1');
    expect(summary.blocks[0].questionCount).toBe(1);
  });

  it('returns empty rows when there are no blocks', () => {
    expect(summarizeFeedBlocks([])).toEqual({ openBlocks: 0, blocks: [] });
  });
});

describe('assembleSnapshot', () => {
  it('stamps version 1, host, and agent tallies from sessions', () => {
    const inventory: ViewJsonAgent[] = [
      { agent: 'claude' as ViewJsonAgent['agent'], versions: [], harnesses: [] },
    ];
    const sessions: SnapshotSessionRow[] = [
      {
        status: 'running',
        context: 'terminal',
        kind: 'claude',
        ticketId: null,
        project: 'agents-cli',
        prLink: null,
        viewingIn: null,
      },
      {
        status: 'idle',
        context: 'teams',
        kind: 'codex',
        ticketId: 'RUSH-1',
        project: null,
        prLink: null,
        viewingIn: null,
      },
    ];
    const snap = assembleSnapshot({
      host: 'zion',
      capturedAt: '2026-08-05T12:00:00.000Z',
      inventory,
      sessions,
      remoteDeviceCount: 0,
    });
    expect(snap.version).toBe(1);
    expect(snap.host).toBe('zion');
    expect(snap.inventory).toBe(inventory);
    expect(snap.harnesses.find((h) => h.id === 'claude')).toMatchObject({
      cliCommand: 'claude',
      modes: ['plan', 'edit', 'auto', 'skip'],
    });
    expect(snap.devices).toEqual([]);
    expect(snap.sessions).toHaveLength(2);
    expect(snap.agents).toEqual({
      running: 1,
      live: 2,
      byContext: { terminal: 1 },
      byAgent: { claude: 1 },
    });
    expect(snap.feed).toBeUndefined();
    expect(snap.sync).toBeUndefined();
  });

  it('carries canonical per-device profile, config, eligibility, and freshness', () => {
    const snap = assembleSnapshot({
      host: 'zion',
      capturedAt: '2026-08-10T09:00:00.000Z',
      inventory: [],
      sessions: [],
      remoteDeviceCount: 0,
      devices: [{
        name: 'zion',
        profile: { name: 'zion', platform: 'darwin' },
        config: { maxAgents: 4 },
        harnesses: [{
          agent: 'claude', version: '2.1.186', account: 'acct', signedIn: true,
          quota: { status: 'out_of_credits', usedPercent: null, stale: false, capturedAt: null, unavailableReason: null },
          ready: false, reason: 'out of credits', capturedAt: 1_786_355_169_244,
        }],
        capturedAt: '2026-08-10T09:46:09.244Z',
        freshness: { status: 'fresh', ageMs: 100, unavailableReason: null },
      }],
    });
    expect(snap.devices[0]).toMatchObject({
      name: 'zion',
      config: { maxAgents: 4 },
      harnesses: [{ ready: false, reason: 'out of credits', quota: { status: 'out_of_credits' } }],
      freshness: { status: 'fresh', unavailableReason: null },
    });
  });

  it('includes feed and sync only when provided', () => {
    const snap = assembleSnapshot({
      host: 'm2',
      capturedAt: '2026-08-05T12:00:00.000Z',
      inventory: [],
      sessions: [],
      remoteDeviceCount: 2,
      feed: { openBlocks: 1, blocks: [] },
    });
    expect(snap.remoteDeviceCount).toBe(2);
    expect(snap.feed).toEqual({ openBlocks: 1, blocks: [] });
    expect(snap.sync).toBeUndefined();
  });
});
