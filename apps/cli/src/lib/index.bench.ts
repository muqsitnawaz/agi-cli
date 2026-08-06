/**
 * Benchmark for the CLI entry hot path: `checkForUpdates()` (index.ts:755) and
 * `spawnDetachedSync()` (index.ts:1330), both of which run on EVERY ordinary
 * `agents` invocation except pure `--help`/`--version` (index.ts:1319-1331 guards
 * them behind `!helpOrVersionRequested`). The comment at index.ts:51 flags this
 * same pair as the reason the secrets-broker sync commands are intercepted
 * above commander registration, before `checkForUpdates()`/`spawnDetachedSync()`
 * would otherwise fire on every cache-hit read.
 *
 * `checkForUpdates` (index.ts:755-779) and its helper `maybeWarnMultiInstall`
 * (index.ts:535-575) are NOT exported -- they are private to index.ts, and
 * index.ts cannot be imported directly: it has top-level `await`, reads
 * `process.argv`, and (outside the two early-intercept blocks at index.ts:38 and
 * index.ts:71) eventually calls `program.parse()`, so importing the module as
 * ESM would run the real CLI bootstrap as a side effect of loading this bench
 * file. Instead this benchmarks the exact exported functions `checkForUpdates`
 * calls, with the same real arguments (this machine's real PATH, its real
 * ~/.agents/.cache/.update-check file):
 *
 *   maybeWarnMultiInstall (index.ts:535-575)
 *     -> resolveRunningPackageRoot (self-update.ts:177)
 *     -> findAgentsCliInstalls(process.env.PATH)      (self-update.ts:509)
 *     -> buildMultiInstallInventory(...)              (self-update.ts:401)
 *   checkForUpdates body (index.ts:755-779)
 *     -> readUpdateCache(UPDATE_CHECK_FILE)           (self-update.ts:79)
 *     -> shouldFetchLatest(cache)                     (index.ts:578, PRIVATE -- see note below)
 *     -> shouldPromptUpgrade(cache, VERSION)           (self-update.ts:128)
 *
 * `shouldFetchLatest` (index.ts:578) is itself private to index.ts (not
 * self-update.ts, despite living right beside the exported update-cache
 * helpers there) -- it is NOT benched directly for the same reason
 * `checkForUpdates` itself isn't: nothing can import it without importing all
 * of index.ts. It is one pure comparison (`Date.now() - cache.lastCheck >
 * UPDATE_CHECK_INTERVAL_MS`), immaterial next to the real fs/PATH work
 * measured below -- readUpdateCache's real fs.readFileSync + JSON.parse
 * dominates it by construction, and readUpdateCache is exported and benched.
 *
 * `refreshUpdateCacheInBackground` (index.ts:739-752) and the interactive
 * `promptUpgrade` path are NOT benched: the former is a fire-and-forget network
 * fetch (`fetch(...).then(...)`, never awaited by the caller) and the latter is
 * an interactive TTY prompt -- neither is on the synchronous hot path this file
 * measures, and neither fires on a plain terminal `agents <cmd>` run against a
 * fresh cache.
 *
 * `spawnDetachedSync` (auto-pull.ts:46-72) IS exported and is benched directly,
 * but with one twist: it resolves its worker script relative to
 * `fileURLToPath(import.meta.url)` (auto-pull.ts:51), i.e. relative to wherever
 * the RUNNING copy of this module lives. Importing it the normal bench way (via
 * './auto-pull.js', vitest's TS-source resolution) would put that module at
 * src/lib/auto-pull.ts, where only auto-pull-worker.TS exists -- so
 * `fs.existsSync(workerPath)` (auto-pull.ts:53) would ALWAYS be false and the
 * function would always take the early-return guard path, never actually
 * spawning anything. That is real behavior for an unbuilt checkout, but it is
 * not what a real user's installed copy does (npm ships dist/lib/auto-pull-
 * worker.js). To measure the real spawn this file imports the ACTUAL BUILT
 * ARTIFACT at ../../dist/lib/auto-pull.js (produced by `bun run build` /
 * `bun install`'s `prepare` hook) so `import.meta.url` resolves inside dist/lib/
 * and the real dist/lib/auto-pull-worker.js is found. Both regimes are benched
 * explicitly below so the guard-path cost and the real fork+exec cost are never
 * conflated.
 *
 * No mocking: every call below hits the real filesystem (real PATH, real
 * ~/.agents/.cache files) and, in the "real spawn" group, a real
 * child_process.spawn of the real dist/lib/auto-pull-worker.js -- which itself
 * does a real `git fetch` against this machine's real ~/.agents repos in the
 * background (detached, unref'd, so it does not block this process or this
 * benchmark's timing; see auto-pull-worker.ts). That group is therefore bounded
 * to a small iteration count, mirroring exec.bench.ts's execAgent group.
 *
 * Lives at src/lib/index.bench.ts, not src/index.bench.ts, so that
 * `typecheck:bench` (package.json:58, globs `src/lib/*.bench.ts
 * src/lib/**\/*.bench.ts`) actually type-checks it -- a prior version at
 * src/index.bench.ts silently sat outside that glob and shipped a stale
 * `@ts-expect-error` (TS2578, unused directive) that no gate caught.
 */
import { describe, bench } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import {
  readUpdateCache,
  shouldPromptUpgrade,
  buildMultiInstallInventory,
  findAgentsCliInstalls,
  resolveRunningPackageRoot,
} from './self-update.js';
import { getUpdateCheckPath, getAgentsDir, getMigratedSentinelPath } from './state.js';
import { isGitRepo } from './git.js';
import { foldLegacySystemRepo } from './migrate.js';
import { ensureInitialized } from '../commands/setup.js';
// Real built artifact (see docblock above) -- NOT './auto-pull.js', which
// would resolve to the unbuilt TS source and always miss the worker script.
// dist/lib/auto-pull.d.ts exists (tsconfig.json declaration:true), so this
// resolves and type-checks normally -- no @ts-expect-error needed here.
import { spawnDetachedSync } from '../../dist/lib/auto-pull.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK_FILE = getUpdateCheckPath();
const REAL_PATH = process.env.PATH || '';

// The bootstrap init/migration triad (index.ts:1354-1411): the SYSTEM_DIR and
// sentinel paths, and the value the sentinel is compared against, exactly as
// index.ts computes them. tests/setup.ts leaves HOME untouched (tests/setup.ts:44),
// so these resolve to the real ~/.agents on this box -- no mocking.
const SYSTEM_DIR = getAgentsDir();
const MIGRATED_SENTINEL_FILE = getMigratedSentinelPath();
// index.ts:1397 -- the sentinel value keyed to the migration SCHEMA version.
const SENTINEL_VALUE = 'v15';
// ensureInitialized(program) (setup.ts) only touches `program` on the
// not-yet-set-up branch; on a settled install it returns right after isGitRepo,
// so a bare Command is never read. Reused across iterations.
const BENCH_PROGRAM = new Command();

describe('checkForUpdates — maybeWarnMultiInstall (index.ts:535-575): the PATH + known-install-root scan', () => {
  bench('resolveRunningPackageRoot(__dirname) — real path math, no fs walk when not a bunfs virtual path (self-update.ts:177)', () => {
    resolveRunningPackageRoot(__dirname);
  });

  bench(`findAgentsCliInstalls(process.env.PATH) — real PATH scan (${REAL_PATH.split(path.delimiter).filter(Boolean).length} real entries on this box) + known nvm/fnm/volta/bun/npx roots (self-update.ts:509)`, () => {
    findAgentsCliInstalls(REAL_PATH);
  });

  bench('maybeWarnMultiInstall end-to-end: resolveRunningPackageRoot + findAgentsCliInstalls + buildMultiInstallInventory (index.ts:539-550) -- dominated by the PATH scan above; the Map-based aggregation itself (self-update.ts:401) is negligible over the small install list it runs on', () => {
    const runningRoot = resolveRunningPackageRoot(__dirname);
    const installs = findAgentsCliInstalls(REAL_PATH);
    buildMultiInstallInventory(runningRoot, '0.0.0-bench', installs);
  });
});

describe('checkForUpdates — cache read + prompt decision (index.ts:755-779)', () => {
  bench(`readUpdateCache(UPDATE_CHECK_FILE) — real ~/.agents/.cache/.update-check read (self-update.ts:79)`, () => {
    readUpdateCache(UPDATE_CHECK_FILE);
  });

  bench('shouldPromptUpgrade — pure comparison against the real cached value, incl. compareVersions (self-update.ts:128)', () => {
    const cache = readUpdateCache(UPDATE_CHECK_FILE);
    shouldPromptUpgrade(cache, '0.0.0-bench');
  });
});

describe('spawnDetachedSync (index.ts:1330, auto-pull.ts:46-72) — guard-path only (AGENTS_NO_AUTOPULL=1, no spawn)', () => {
  bench('early return: env check only (auto-pull.ts:47)', () => {
    process.env.AGENTS_NO_AUTOPULL = '1';
    spawnDetachedSync();
  });
});

describe('spawnDetachedSync — real detached child_process.spawn against the built dist/lib/auto-pull-worker.js', () => {
  bench('fileURLToPath + path.join + fs.existsSync + spawn().unref() (auto-pull.ts:51-68) — forks a real process, real background git fetch', () => {
    delete process.env.AGENTS_NO_AUTOPULL;
    spawnDetachedSync();
  }, { time: 2000, iterations: 10 });
});

/**
 * The SECOND half of the CLI-entry hot path: the init/migration triad that
 * runs on EVERY ordinary `agents <cmd>` invocation AFTER checkForUpdates /
 * spawnDetachedSync (benched above) and BEFORE `program.parseAsync()`
 * (index.ts:1440). Three checks fire in sequence at index.ts:1354-1411, each
 * unconditional on a non-exempt command (`setup`/`help`/`uninstall` are the
 * only exemptions, index.ts:1357):
 *
 *   1. foldLegacySystemRepo()          index.ts:1369  (migrate.ts:49)
 *        -> fs.lstatSync(~/.agents-system)  (migrate.ts:51) — one syscall.
 *        Deliberately OUTSIDE the sentinel guard (index.ts:1359-1365): the
 *        sentinel predates the fold, so it can't gate it. On this box
 *        ~/.agents-system is absent, so the lstat THROWS ENOENT and is caught
 *        (migrate.ts:51) — the settled-install steady state.
 *   2. ensureInitialized(program)      index.ts:1380  (setup.ts)
 *        -> isGitRepo(getAgentsDir())       (setup.ts) = fs.existsSync(
 *        ~/.agents/.system/.git) (git.ts). On a set-up box that returns true
 *        and ensureInitialized returns immediately — never reaching the
 *        interactive/exit branches — so this single existsSync IS the whole
 *        per-command cost of the function.
 *   3. migration sentinel gate         index.ts:1399-1403
 *        -> fs.existsSync(sentinel) && fs.readFileSync(sentinel,'utf-8').trim()
 *        === 'v15'. When it matches (settled install), needRun=false and
 *        runMigration() (index.ts:1405) is NOT called. Two syscalls
 *        (existsSync THEN readFileSync — a TOCTOU double-stat of the same path).
 *
 * No mocking: every call hits the real filesystem via the real path constants
 * (getAgentsDir / getMigratedSentinelPath), which tests/setup.ts leaves pointing
 * at the real ~/.agents (tests/setup.ts:44 — HOME untouched).
 *
 * runMigration() (migrate.ts, ~40 sub-migrators) is NOT benched by executing it.
 * It is gated by the sentinel (verified `v15` on this box), so it does NOT run on
 * a settled install — the very path this file measures is the guard that keeps it
 * off the hot path. And it MUTATES live state on a sentinel miss —
 * migrateSplitDeviceLocalMeta (migrate.ts) rewrites the real ~/.agents/agents.yaml
 * when it still carries machine-local `agents:`/`versions:` keys, migrateCliDirToClis
 * (migrate.ts) throws on a cli/+clis/ collision, and repairAgentConfigSymlinks
 * (migrate.ts:686) re-points ~/.claude & co. Running that sweep in a benchmark loop
 * against the user's real ~/.agents would corrupt it, so it is deliberately left
 * unexecuted; the sentinel-gate bench below is what quantifies its per-command
 * amortized cost (one cache-file read that decides whether the sweep runs at all).
 */
describe('init/migration triad (index.ts:1354-1411) — per-command bootstrap checks before parse', () => {
  bench('foldLegacySystemRepo() — real fs.lstatSync(~/.agents-system) ENOENT+catch on a folded install (index.ts:1369, migrate.ts:49-52)', () => {
    foldLegacySystemRepo();
  });

  bench('isGitRepo(getAgentsDir()) — real fs.existsSync(~/.agents/.system/.git); the entire settled-install cost of ensureInitialized (index.ts:1380, setup.ts, git.ts)', () => {
    isGitRepo(SYSTEM_DIR);
  });

  bench('ensureInitialized(program) — the real named function; on a set-up box returns right after isGitRepo, so ~equal to the bench above (index.ts:1380, setup.ts)', async () => {
    await ensureInitialized(BENCH_PROGRAM);
  });

  bench('migration sentinel gate — real fs.existsSync + fs.readFileSync(~/.agents/.cache/.migrated).trim() === "v15" (index.ts:1399-1403)', () => {
    if (fs.existsSync(MIGRATED_SENTINEL_FILE) && fs.readFileSync(MIGRATED_SENTINEL_FILE, 'utf-8').trim() === SENTINEL_VALUE) {
      /* needRun = false — runMigration() skipped */
    }
  });

  bench('full triad end-to-end: foldLegacySystemRepo + isGitRepo + sentinel gate — every fs syscall an ordinary command runs before parse (index.ts:1369,1380,1399-1403)', () => {
    foldLegacySystemRepo();
    isGitRepo(SYSTEM_DIR);
    if (fs.existsSync(MIGRATED_SENTINEL_FILE) && fs.readFileSync(MIGRATED_SENTINEL_FILE, 'utf-8').trim() === SENTINEL_VALUE) {
      /* needRun = false */
    }
  });
});
