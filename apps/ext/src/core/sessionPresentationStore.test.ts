import { describe, expect, test } from 'bun:test';
import { SessionPresentationStore } from './sessionPresentationStore';

describe('SessionPresentationStore', () => {
  test('projects reset/upsert/remove without deriving lifecycle state', () => {
    const store = new SessionPresentationStore();
    store.apply({ version: 1, type: 'reset', sessions: [{ id: 'a', status: 'active' }] });
    store.apply({ version: 2, type: 'upsert', session: { id: 'b', status: 'orphaned' } });
    store.apply({ version: 3, type: 'remove', id: 'a' });
    expect(store.sessions()).toEqual([{ id: 'b', status: 'orphaned' }]);
  });

  test('ignores stale events', () => {
    const store = new SessionPresentationStore();
    store.apply({ version: 5, type: 'reset', sessions: [{ id: 'new' }] });
    expect(store.apply({ version: 4, type: 'remove', id: 'new' })).toBe(false);
    expect(store.sessions()).toEqual([{ id: 'new' }]);
  });
});
