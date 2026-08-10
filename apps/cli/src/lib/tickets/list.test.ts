import { describe, expect, it } from 'vitest';
import { listTickets } from './list.js';

describe('listTickets', () => {
  it('returns the stable empty aggregate when both sources are disabled', async () => {
    await expect(listTickets({
      cwd: process.cwd(),
      linear: false,
      github: false,
      githubAssignedOnly: false,
    })).resolves.toEqual({
      tickets: [],
      cycleInfo: null,
      sources: {
        linear: { available: false },
        github: { available: false },
      },
    });
  });
});
