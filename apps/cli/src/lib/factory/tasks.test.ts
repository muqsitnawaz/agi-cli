import { describe, expect, it } from 'vitest';
import { listFactoryTasks } from './tasks.js';

describe('listFactoryTasks', () => {
  it('returns the stable empty aggregate when both canonical sources are excluded', async () => {
    await expect(listFactoryTasks({ cwd: process.cwd(), linear: false, github: false, assignedOnly: false })).resolves.toEqual({
      tasks: [],
      cycleInfo: null,
      sources: { linear: false, github: false },
    });
  });
});
