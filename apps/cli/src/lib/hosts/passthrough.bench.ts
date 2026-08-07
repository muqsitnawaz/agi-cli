/**
 * Benchmark for the `--host` passthrough bootstrap — the hot path every named
 * CLI invocation pays.
 *
 * `src/index.ts:1290-1295` runs, for EVERY invocation that names a command and
 * is not `--help`/`--version`:
 *
 *   const { maybeRunOnHost } = await import('./lib/hosts/passthrough.js');
 *   if (await maybeRunOnHost(requestedCommand, passedArgs)) { … }
 *
 * That happens before command registration (`registerEagerForRequest`,
 * `src/index.ts:1309`), so it is serial cold-start latency on `agents view`,
 * `agents sync`, `agents skills list` — every one of which passes no routing
 * flag and gets `false` back from `maybeRunOnHost:475`.
 *
 * Two costs are measured separately because they have different fixes:
 *
 *  1. **module graph** — what `await import('./lib/hosts/passthrough.js')`
 *     costs cold, measured against a same-flag `node` baseline in a fresh
 *     process (`dist/` is the artifact the shipped CLI actually loads).
 *  2. **function body** — what `maybeRunOnHost` costs once the graph is warm,
 *     across realistic argvs on both the no-flag path and the flag-present
 *     early-return branches.
 *
 * Only side-effect-free branches are exercised: the no-flag return at
 * `passthrough.ts:475`, the `OWN_HOST_COMMANDS` return at `:481` and the
 * unknown-command return at `:515`. No branch here opens an SSH connection,
 * loads the device registry, or writes anything — the bench is safe to run on
 * any box.
 *
 * No existing bench covered this path before this file. `index.bench.ts` covers
 * the OTHER two per-invocation entry costs (`checkForUpdates` index.ts:755 and
 * `spawnDetachedSync` index.ts:1330) and states so in its own header;
 * `hosts/dispatch.bench.ts` covers host resolution and SSH command-building —
 * i.e. what runs AFTER `maybeRunOnHost` decides to route. Neither imports
 * `passthrough.ts`, so the every-invocation bootstrap measured here was
 * unbenched. One bench file per source file is this package's existing layout
 * (`brand.bench.ts`, `events.bench.ts`, `exec.bench.ts`, `hosts/dispatch.bench.ts`,
 * `session/db.bench.ts`, …), so this sits beside `passthrough.ts`.
 *
 * Not run by `vitest run`: `vitest.config.ts:18` includes only `*.test.ts`, so
 * this file adds no CI assertion and no flakiness. It IS type-checked, by
 * `typecheck:bench` (package.json:60, globs `src/lib/**\/*.bench.ts`). Run it:
 *
 *   npx vitest bench --run src/lib/hosts/passthrough.bench.ts   # from apps/cli
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { bench, describe } from 'vitest';
import { maybeRunOnHost, flagValue } from './passthrough.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib/hosts -> apps/cli
const cliRoot = path.resolve(here, '../../..');
const distPassthrough = path.join(cliRoot, 'dist/lib/hosts/passthrough.js');

// Fail loud rather than silently skipping: a cold-import number measured
// against a missing artifact would be meaningless.
if (!fs.existsSync(distPassthrough)) {
  throw new Error(
    `passthrough.bench.ts needs the built artifact at ${distPassthrough}. ` +
      `Build it first: bash scripts/build.sh (from apps/cli).`,
  );
}

/** Spawn a fresh node and return only after it exits — one full cold start. */
function coldNode(source: string): void {
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'ignore',
    cwd: cliRoot,
  });
}

const distUrl = pathToFileURL(distPassthrough).href;

describe('cold module graph (per CLI invocation, out-of-process)', () => {
  bench(
    'node baseline (no import)',
    () => {
      coldNode('void 0;');
    },
    { iterations: 20, time: 0 },
  );

  bench(
    'node + import dist/lib/hosts/passthrough.js',
    () => {
      coldNode(`await import(${JSON.stringify(distUrl)});`);
    },
    { iterations: 20, time: 0 },
  );
});

/**
 * Which of `passthrough.ts`'s static imports carry the graph. Each is imported
 * alone in a fresh process, so the numbers are per-subgraph (they overlap — the
 * subgraphs share deps — and do not sum to the whole-file number above).
 *
 * Every entry here is reached ONLY after a routing flag is found, i.e. never on
 * the `return false` at `passthrough.ts:475` that the overwhelming majority of
 * invocations take:
 *   - `smart-launch.js`  (passthrough.ts:34) — used at :558 (`--device auto`)
 *   - `dispatch.js`      (passthrough.ts:24) — used at :607, :716
 *   - `registry.js`      (passthrough.ts:22) — used at :183, :187
 *   - `sync/config.js`   (passthrough.ts:33) — `machineId` at :395, and it is a
 *                         pure re-export of `machine-id.js` (sync/config.ts:145)
 *   - `health-report.js` (passthrough.ts:45) — `platformGroupLabel` at :335
 */
const HEAVY_IMPORTS: Array<[string, string]> = [
  ['lib/smart-launch.js (passthrough.ts:34)', 'smart-launch.js'],
  ['lib/hosts/dispatch.js (passthrough.ts:24)', 'hosts/dispatch.js'],
  ['lib/hosts/registry.js (passthrough.ts:22)', 'hosts/registry.js'],
  ['lib/session/sync/config.js (passthrough.ts:33)', 'session/sync/config.js'],
  ['lib/devices/health-report.js (passthrough.ts:45)', 'devices/health-report.js'],
  ['lib/machine-id.js (the leaf sync/config re-exports)', 'machine-id.js'],
  ['lib/startup/command-registry.js (passthrough.ts:46)', 'startup/command-registry.js'],
];

describe('cold import per static dependency (out-of-process)', () => {
  for (const [label, rel] of HEAVY_IMPORTS) {
    const target = path.join(cliRoot, 'dist/lib', rel);
    bench(
      label,
      () => {
        coldNode(`await import(${JSON.stringify(pathToFileURL(target).href)});`);
      },
      { iterations: 20, time: 0 },
    );
  }
});

/**
 * Realistic no-flag invocations — the 100% case for a local `agents <cmd>`.
 * Each returns `false` at `passthrough.ts:475` after four `flagValue` scans.
 */
const NO_FLAG_ARGVS: Array<[string, string[]]> = [
  ['view', ['view']],
  ['sync claude --yes', ['sync', 'claude', '--yes']],
  ['skills list', ['skills', 'list']],
  ['doctor', ['doctor']],
  [
    'run claude (long argv)',
    ['run', 'claude', '--mode', 'edit', '--name', 'bench', '--profile', 'default', '-p', 'do the thing', '--json'],
  ],
];

describe('maybeRunOnHost — no routing flag (warm graph)', () => {
  for (const [label, argv] of NO_FLAG_ARGVS) {
    bench(`agents ${label}`, async () => {
      await maybeRunOnHost(argv[0], argv);
    });
  }
});

describe('maybeRunOnHost — routing flag present, side-effect-free returns', () => {
  // OWN_HOST_COMMANDS member -> returns false at passthrough.ts:481.
  bench('agents sessions --host box (own-host early return)', async () => {
    await maybeRunOnHost('sessions', ['sessions', '--host', 'box']);
  });

  // Not a known top-level command -> returns false at passthrough.ts:515.
  bench('agents sessoins --host box (unknown-command return)', async () => {
    await maybeRunOnHost('sessoins', ['sessoins', '--host', 'box']);
  });
});

describe('flagValue — the four argv scans maybeRunOnHost:467-470 always runs', () => {
  const short = ['view'];
  const long = NO_FLAG_ARGVS[4][1];

  bench('flagValue x4 over ["view"]', () => {
    flagValue(short, 'host', 'H');
    flagValue(short, 'device');
    flagValue(short, 'hosts');
    flagValue(short, 'devices');
  });

  bench('flagValue x4 over an 11-token argv', () => {
    flagValue(long, 'host', 'H');
    flagValue(long, 'device');
    flagValue(long, 'hosts');
    flagValue(long, 'devices');
  });
});
