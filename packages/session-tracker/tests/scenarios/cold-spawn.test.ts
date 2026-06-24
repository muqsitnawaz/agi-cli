<<<<<<< HEAD
import { describe, it, expect } from 'vitest';
import { spawnAndDetect, killAndCleanup, suppressIo, type SpawnRun } from '../harness.js';

const ITERATIONS = Number(process.env.COLD_SPAWN_ITERATIONS ?? 20);

interface Sample {
  iter: number;
  truth: string | null;
  detected: string | null;
  matched: boolean;
  latencyMs: number;
  method: string | null;
  truthLatencyMs: number;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe(`cold-spawn × ${ITERATIONS}`, () => {
  it(
    'detection rate and latency for sequential Claude cold spawns',
    async () => {
      const samples: Sample[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        let run: SpawnRun | undefined;
        try {
          run = await spawnAndDetect({ agent: 'claude' });
          suppressIo(run.proc);
          samples.push({
            iter: i,
            truth: run.truth?.sessionId ?? null,
            detected: run.detected.sessionId,
            matched: run.matched,
            latencyMs: run.detected.latencyMs,
            method: run.detected.method,
            truthLatencyMs: run.truth?.latencyMs ?? -1,
          });
        } catch (err) {
          samples.push({
            iter: i,
            truth: null,
            detected: null,
            matched: false,
            latencyMs: -1,
            method: null,
            truthLatencyMs: -1,
          });
          console.error(`iter ${i} threw:`, (err as Error).message);
        } finally {
          if (run) await killAndCleanup(run);
        }
        // brief breather so STATE_DIR isn't hammered
        await new Promise((r) => setTimeout(r, 200));
      }

      const detected = samples.filter((s) => s.detected !== null).length;
      const truthFound = samples.filter((s) => s.truth !== null).length;
      const matched = samples.filter((s) => s.matched).length;
      const lats = samples.filter((s) => s.matched).map((s) => s.latencyMs);
      const truthLats = samples.filter((s) => s.truth).map((s) => s.truthLatencyMs);
      const methods = samples.reduce<Record<string, number>>((acc, s) => {
        const k = s.method ?? 'none';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});

      const matchRate = matched / ITERATIONS;
      const detectRate = detected / ITERATIONS;
      const truthRate = truthFound / ITERATIONS;

      console.log('');
      console.log('=== cold-spawn report (claude) ===');
      console.log(`iterations:    ${ITERATIONS}`);
      console.log(`truth found:   ${truthFound} (${(truthRate * 100).toFixed(1)}%)`);
      console.log(`detected:      ${detected} (${(detectRate * 100).toFixed(1)}%)`);
      console.log(`matched:       ${matched} (${(matchRate * 100).toFixed(1)}%)`);
      console.log(
        `tracker p50/p95/p99 ms: ${percentile(lats, 50)} / ${percentile(lats, 95)} / ${percentile(lats, 99)} (max ${Math.max(0, ...lats)})`,
      );
      console.log(
        `truth   p50/p95/p99 ms: ${percentile(truthLats, 50)} / ${percentile(truthLats, 95)} / ${percentile(truthLats, 99)} (max ${Math.max(0, ...truthLats)})`,
      );
      console.log(`methods: ${JSON.stringify(methods)}`);
      const failures = samples.filter((s) => !s.matched);
      if (failures.length > 0) {
        console.log(`failures (${failures.length}):`);
        for (const f of failures.slice(0, 5)) {
          console.log(`  iter ${f.iter}: truth=${f.truth} detected=${f.detected} method=${f.method}`);
        }
      }
      console.log('');

      // Phase-1 reliability gate.
      expect(matchRate, `match rate ${(matchRate * 100).toFixed(1)}% below 95%`).toBeGreaterThanOrEqual(0.95);
      expect(percentile(lats, 95), `p95 latency ${percentile(lats, 95)}ms above 10s`).toBeLessThanOrEqual(10_000);
    },
    // 30s per iteration headroom (real ~6s + 200ms breather + cleanup overhead).
    ITERATIONS * 30_000,
  );
});
=======
import { afterAll, expect, test } from 'vitest';
import { spawnAndDetect, killAndCleanup } from '../harness.js';
import {
  ScenarioRecorder,
  percentile,
  sleep,
} from '../lib/scenario-record.js';

// 50 fresh-cwd cold spawns. This is the headline reliability number: does the
// SessionStart hook land a parseable state file fast enough, every time, for a
// brand-new agent in a directory it has never seen?
const ITERATIONS = 50;
const MATCH_RATE_THRESHOLD = 0.99;
const P95_LATENCY_MS = 1000;

const recorder = new ScenarioRecorder('cold-spawn', 'claude');

afterAll(async () => {
  await recorder.flush();
});

test(
  `cold-spawn: ${ITERATIONS} sequential fresh-cwd claude spawns`,
  async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const run = await spawnAndDetect({ agent: 'claude' });
      try {
        recorder.add({
          iteration: i,
          truth: run.truthSessionId,
          detected: run.detected.sessionId,
          matched: run.matched,
          latencyMs: run.detected.latencyMs,
          method: run.detected.method,
          cwd: run.cwd,
          pid: run.proc.pid,
        });
      } finally {
        await killAndCleanup(run);
      }
      // Don't hammer STATE_DIR / pgrep between iterations.
      await sleep(200);
    }

    const records = recorder.all;
    const matched = records.filter((r) => r.matched).length;
    const matchRate = matched / records.length;
    const latencies = records.map((r) => r.latencyMs);
    const p95 = percentile(latencies, 95);

    const failures = records.filter((r) => !r.matched);
    if (failures.length > 0) {
      // Surface enough to debug a missed detection: ground truth vs what the
      // tracker reported, plus the cwd/pid that produced it.
      console.error(
        `cold-spawn ${failures.length}/${records.length} mismatches:\n` +
          failures
            .map(
              (f) =>
                `  iter=${f.iteration} truth=${f.truth} detected=${f.detected} cwd=${f.cwd} pid=${f.pid}`,
            )
            .join('\n'),
      );
    }

    expect(
      matchRate,
      `match rate ${(matchRate * 100).toFixed(1)}% < ${MATCH_RATE_THRESHOLD * 100}%`,
    ).toBeGreaterThanOrEqual(MATCH_RATE_THRESHOLD);
    expect(
      p95,
      `p95 latency ${p95.toFixed(0)}ms >= ${P95_LATENCY_MS}ms`,
    ).toBeLessThan(P95_LATENCY_MS);
  },
  600_000,
);
>>>>>>> origin/main
