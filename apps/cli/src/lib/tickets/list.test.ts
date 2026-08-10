import { describe, expect, it } from 'vitest';
import { listTickets } from './list.js';

describe('listTickets', () => {
  it('returns the stable empty aggregate when both canonical sources are excluded', async () => {
    await expect(listTickets({ cwd: process.cwd(), linear: false, github: false, assignedOnly: false })).resolves.toEqual({
      tickets: [],
      cycleInfo: null,
      sources: { linear: false, github: false },
    });
  });
});
