import { describe, it, expect } from 'vitest';
import { spawnAndDetect, killAndCleanup, suppressIo } from './harness.js';

describe('smoke', () => {
  it(
<<<<<<< HEAD
    'claude headless spawn — tracker matches ground truth',
=======
    'claude cold spawn — tracker matches ground truth',
>>>>>>> origin/main
    async () => {
      const run = await spawnAndDetect({ agent: 'claude' });
      suppressIo(run.proc);
      try {
        expect(run.truth, 'no Claude session file appeared (ground truth)').toBeTruthy();
        expect(run.detected.sessionId, 'tracker returned no sessionId').toBeTruthy();
<<<<<<< HEAD
        expect(
          run.matched,
          `mismatch — truth=${run.truth?.sessionId} detected=${run.detected.sessionId}`,
        ).toBe(true);
        expect(run.detected.latencyMs).toBeLessThan(15_000);
=======
        expect(run.matched, `mismatch — truth=${run.truth?.sessionId} detected=${run.detected.sessionId}`).toBe(true);
        expect(run.detected.latencyMs).toBeLessThan(5000);
>>>>>>> origin/main
      } finally {
        await killAndCleanup(run);
      }
    },
<<<<<<< HEAD
    60_000,
=======
    30_000,
>>>>>>> origin/main
  );
});
