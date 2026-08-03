import { describe, expect, test } from 'bun:test';
import { forkEdgesBySessionId, recordForkEdge, type ForkEdge } from './forkLineage';

function edge(over: Partial<ForkEdge> = {}): ForkEdge {
  return {
    sourceSessionId: 'src-1',
    sourceHost: 'zion',
    forkSessionId: 'fork-1',
    forkHost: 'yosemite-m0',
    agentKey: 'claude',
    forkedAt: 1_000,
    ...over,
  };
}

describe('recordForkEdge', () => {
  test('puts the newest fork first', () => {
    const one = edge();
    const two = edge({ forkSessionId: 'fork-2', forkedAt: 2_000 });
    expect(recordForkEdge([one], two).map((e) => e.forkSessionId)).toEqual(['fork-2', 'fork-1']);
  });

  test('replaces an edge for the same fork instead of stacking a duplicate', () => {
    const first = edge({ forkHost: 'yosemite-m0' });
    const relaunch = edge({ forkHost: 'mac-mini', forkedAt: 3_000 });
    const edges = recordForkEdge([first], relaunch);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ forkHost: 'mac-mini', forkedAt: 3_000 });
  });

  test('keeps an idless fork edge rather than dropping the record', () => {
    const edges = recordForkEdge([edge()], edge({ forkSessionId: null, forkedAt: 4_000 }));
    expect(edges).toHaveLength(2);
    expect(edges[0].forkSessionId).toBeNull();
  });

  test('caps the ledger at the newest N edges', () => {
    let edges: ForkEdge[] = [];
    for (let i = 0; i < 5; i++) {
      edges = recordForkEdge(edges, edge({ forkSessionId: `fork-${i}`, forkedAt: i }), 3);
    }
    expect(edges.map((e) => e.forkSessionId)).toEqual(['fork-4', 'fork-3', 'fork-2']);
  });
});

describe('forkEdgesBySessionId', () => {
  test('indexes by fork id and skips edges that never got one', () => {
    const index = forkEdgesBySessionId([
      edge({ forkSessionId: null }),
      edge({ forkSessionId: 'fork-9', sourceHost: 'mac-mini' }),
    ]);
    expect([...index.keys()]).toEqual(['fork-9']);
    expect(index.get('fork-9')?.sourceHost).toBe('mac-mini');
  });

  test('the newest edge wins a repeated fork id', () => {
    const index = forkEdgesBySessionId([
      edge({ forkHost: 'mac-mini', forkedAt: 5_000 }),
      edge({ forkHost: 'yosemite-m0', forkedAt: 1_000 }),
    ]);
    expect(index.get('fork-1')?.forkHost).toBe('mac-mini');
  });
});
