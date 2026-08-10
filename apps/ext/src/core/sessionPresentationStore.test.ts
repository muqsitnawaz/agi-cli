import { describe, expect, test } from 'bun:test';
import { SessionPresentationStore } from './sessionPresentationStore';

describe('SessionPresentationStore', () => {
  test('projects reset/upsert/remove without deriving lifecycle state', () => {
    const store = new SessionPresentationStore();
    store.apply({ version: 1, type: 'reset', streamId: 's', sequence: 1, capturedAt: 1, scope: 'zion', rows: [{ rowKey: 'a', sourceDevice: 'zion', status: 'active' }] });
    store.apply({ version: 1, type: 'upsert', streamId: 's', sequence: 2, capturedAt: 2, scope: 'zion', rowKey: 'b', row: { rowKey: 'b', sourceDevice: 'zion', status: 'orphaned' } });
    store.apply({ version: 1, type: 'remove', streamId: 's', sequence: 3, capturedAt: 3, scope: 'zion', rowKey: 'a' });
    expect(store.sessions()).toEqual([{ rowKey: 'b', sourceDevice: 'zion', status: 'orphaned' }]);
  });

  test('orders each stream independently and resets only its scope', () => {
    const store = new SessionPresentationStore();
    store.apply({ version: 1, type: 'reset', streamId: 'a', sequence: 5, capturedAt: 1, scope: 'zion', rows: [{ rowKey: 'z', sourceDevice: 'zion' }] });
    store.apply({ version: 1, type: 'reset', streamId: 'b', sequence: 1, capturedAt: 1, scope: 'yosemite-s1', rows: [{ rowKey: 'y', sourceDevice: 'yosemite-s1' }] });
    expect(store.apply({ version: 1, type: 'remove', streamId: 'a', sequence: 4, capturedAt: 2, scope: 'zion', rowKey: 'z' })).toBe(false);
    expect(store.sessions()).toEqual([{ rowKey: 'z', sourceDevice: 'zion' }, { rowKey: 'y', sourceDevice: 'yosemite-s1' }]);
  });
});
