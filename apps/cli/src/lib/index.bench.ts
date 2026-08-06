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
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import {
  readUpdateCache,
  shouldPromptUpgrade,
  buildMultiInstallInventory,
  findAgentsCliInstalls,
  resolveRunningPackageRoot,
} from './self-update.js';
import { getUpdateCheckPath } from './state.js';
// Real built artifact (see docblock above) -- NOT './auto-pull.js', which
// would resolve to the unbuilt TS source and always miss the worker script.
// dist/lib/auto-pull.d.ts exists (tsconfig.json declaration:true), so this
// resolves and type-checks normally -- no @ts-expect-error needed here.
import { spawnDetachedSync } from '../../dist/lib/auto-pull.js';
import { loadDoctor, loadVersions, loadPrune, loadSessions } from './startup/command-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK_FILE = getUpdateCheckPath();
const REAL_PATH = process.env.PATH || '';

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
 * ============================================================================
 * Command registration hot path: registerEagerForRequest / COMMAND_LOADERS
 * (index.ts:1007-1063, lib/startup/command-registry.ts) and the
 * program.parseAsync() call it feeds (index.ts:1440).
 *
 * Every ordinary `agents <cmd>` invocation resolves `requestedCommand` from
 * argv (index.ts:1232), looks it up in COMMAND_LOADERS
 * (command-registry.ts:155-274), dynamically imports the one-or-two command
 * modules that name maps to, and calls the returned registrar(program)
 * (index.ts:1010-1012 `reg`) BEFORE program.parseAsync() ever runs
 * (index.ts:1440) -- unconditionally, regardless of `--help`/`--version`
 * (index.ts:1271-1280 has no helpOrVersionRequested guard). An unrecognized
 * top-level name (typo, or the brand-disabled path) instead falls back to
 * registerAllEagerCommands() (index.ts:1072-1161), which imports and
 * registers EVERY command module in the CLI so the Levenshtein "did you mean"
 * spellcheck (index.ts:1184-1226) has the full candidate set.
 *
 * index.ts cannot be imported directly (see the docblock at the top of this
 * file -- top-level await, process.argv reads, eventual program.parse()), and
 * neither `reg` nor `registerEagerForRequest` nor `registerAllEagerCommands`
 * is exported, so there is no way to call them in-process without duplicating
 * their dispatch/ordering logic -- exactly the real coupling command-
 * registry.ts's own docblock (command-registry.ts:141-153) says not to
 * re-derive. Two complementary regimes are benched instead:
 *
 *   1. REAL SPAWNED PROCESS (below): `spawnSync` the actual built
 *      dist/index.js with a handful of representative top-level names, each a
 *      fresh Node process -- i.e. a genuinely COLD run of the entire dispatch
 *      path above, exactly as a user's shell invokes it. `--help` is appended
 *      to every invocation so each run exits fast and deterministically
 *      (commander prints help and exits 0) without touching stdin. `--help`
 *      does skip checkForUpdates/spawnDetachedSync (benched above) and
 *      ensureInitialized/runMigration (index.ts:1373-1381, both DO carry a
 *      `!helpOrVersionRequested` guard -- the sibling migration-triad bench in
 *      PR #2277 covers that path), so this isolates the registration/import
 *      cost from those other two hot-path pieces instead of conflating them.
 *   2. WARM IN-PROCESS REGISTRATION (further below): call the real, exported
 *      command-registry.ts loaders directly -- `(await loadX())(new
 *      Command())` -- for a representative subset. Node's ESM loader caches a
 *      module after its first import in this process, so after the first
 *      sample every further call pays ONLY the registrar function's own
 *      synchronous commander-construction work (.command/.option/.action
 *      calls), not disk read + parse + top-level module evaluation. Compared
 *      against group 1's real cold-process numbers for the SAME command, the
 *      gap approximates how much of the real-world cost is "importing the
 *      module and its dependency graph" versus "building the commander
 *      command tree" -- the same decomposition PR #2277 used to show
 *      ensureInitialized's hot-path body is a single syscall dwarfed by its
 *      eager unconditional import.
 *
 * No mocking: group 1 runs the real built dist/index.js against this
 * machine's real ~/.agents (same real filesystem/PATH every other group in
 * this file uses); group 2 calls the real, unmodified command registrars
 * exported from command-registry.ts.
 */
const CLI_ENTRY = path.join(__dirname, '../../dist/index.js');

function runCli(args: string[]): void {
  // spawnSync (not execFileSync) so a non-zero exit never throws inside the
  // timed callback -- every arg list below is verified to exit 0 on this
  // machine, but the bench must stay robust to environment drift.
  spawnSync(process.execPath, [CLI_ENTRY, ...args], { stdio: 'ignore' });
}

describe('registerEagerForRequest / COMMAND_LOADERS — real cold `node dist/index.js <cmd> --help` process spawn (index.ts:1007-1063, 1271-1280)', () => {
  bench('baseline: `agents --help` — requestedCommand undefined, ZERO command loaders run (index.ts:1281-1284)', () => {
    runCli(['--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents doctor --help` — 1 loader (loadDoctor), single COMMAND_LOADERS entry (command-registry.ts:201)', () => {
    runCli(['doctor', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents prune --help` — 2 loaders in sequence (loadVersions, loadPrune — command-registry.ts:177, ordering comment at 148-149)', () => {
    runCli(['prune', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents sessions --help` — lazy-tree command, the SQLite-backed session module (index.ts:1290-1291, LAZY_COMMAND_NAMES)', () => {
    runCli(['sessions', '--help']);
  }, { time: 4000, iterations: 15 });

  bench('`agents <unknown> --help` — registerAllEagerCommands() fallback, EVERY command module in the CLI (index.ts:1072-1161, 1271-1280)', () => {
    runCli(['zzzznotarealcommand', '--help']);
  }, { time: 6000, iterations: 12 });
});

describe('command-registry.ts loaders — warm in-process registration only (module import cached after the first sample; see docblock above)', () => {
  bench('loadDoctor()(new Command()) — registerDoctorCommand body only, no import cost after first sample', async () => {
    (await loadDoctor())(new Command());
  });

  bench('loadVersions()(new Command()) then loadPrune()(...) — the real `prune` two-loader sequence, in order', async () => {
    const program = new Command();
    (await loadVersions())(program);
    (await loadPrune())(program);
  });

  bench('loadSessions()(new Command()) — registerSessionsCommands body only, no import cost after first sample', async () => {
    (await loadSessions())(new Command());
  });
});

/**
 * ============================================================================
 * Module loading: the eager ESM graph index.ts evaluates BEFORE any argv fast
 * path (index.ts:10-16, 36, 86-95, 124-215) and the command modules
 * COMMAND_LOADERS pulls in afterwards (command-registry.ts:32-119).
 *
 * This is a different cost from the registration group above. Registration
 * measures the commander work a command's registrar does; this measures the
 * cost of *evaluating the module graph itself* — disk reads, parse, and
 * top-level evaluation of every transitively imported module. ESM hoists the
 * static imports at index.ts:10-16 / 36 / 86-95 / 124-215 above every statement
 * in the file, so all of it is paid before `process.argv[2] === '__vault-age-
 * helper'` (index.ts:38) can short-circuit, before the secrets-broker intercept
 * (index.ts:71-84), and before `--version` prints. index.ts:17-21 states this is
 * the thing "that gets cold starts under the target"; command-registry.ts:4-13
 * states the same for the command tree.
 *
 * Method — cold child process per sample, no mocking. Node caches an ESM module
 * for the life of a process, so a second in-process `import()` of the same
 * specifier measures nothing but a Map lookup: an honest module-load number can
 * only come from a fresh process. Each bench below spawns a real `node
 * --input-type=module -e "await import(...)"` that imports the REAL built
 * modules under dist/ (the same artifacts `agents` runs, built by
 * scripts/build.sh / bun install's `prepare`), against this machine's real
 * filesystem. Every bench in the group spawns the identical shape, so the
 * constant Node-spawn floor cancels between rows; `BASELINE` below is that floor
 * measured directly, so any row minus BASELINE is that graph's own load cost.
 *
 * index.ts itself is deliberately NOT imported here, for the reason in this
 * file's top docblock: it has top-level await, reads process.argv, and ends in
 * program.parseAsync() (index.ts:1440), so importing it would run the CLI. The
 * import list below is transcribed from its static imports instead, in source
 * order, and `bootstrapGraph` unions them into the single graph a real
 * invocation evaluates.
 */
const DIST_DIR = path.join(__dirname, '../../dist');
/** A dist module, as the `file://` specifier a spawned child can import. */
const dist = (rel: string): string => pathToFileURL(path.join(DIST_DIR, rel)).href;

/**
 * Cold-import `specs` in a fresh Node process. Empty list = the spawn floor.
 *
 * Fails loud on a non-zero exit. A mistyped or moved specifier makes the child
 * die in ~13ms — BELOW the ~14-18ms bare-spawn baseline — so a swallowed
 * failure would not just go unnoticed, it would read as the fastest row in the
 * table. The repo's fail-loud-at-boundaries convention, applied to a benchmark:
 * a row that measures nothing must say so, not post a good number.
 */
function coldImport(specs: string[]): void {
  const src = specs.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`cold import failed (status ${r.status}, signal ${r.signal}): ${String(r.stderr).slice(0, 400)}`);
  }
}

/**
 * The static imports of src/index.ts, in source order.
 *
 * They do NOT stop at index.ts:215. index.ts:513-524 declares three more, and
 * ESM hoists them with the rest — the built entry keeps them as top-level
 * imports at dist/index.js:393 (state.js) and dist/index.js:394 (brand.js),
 * evaluated before any statement runs, exactly like dist/index.js:8
 * (commander). Both are load-bearing
 * here, not incidental: brand.ts:20 imports agents.js, and agents.ts:26 imports
 * ./versions.js — so this list reaches the 3738-line sync engine by a SECOND
 * edge, independent of self-update.ts:20. A version of this bench that stopped
 * at index.ts:215 measured a saving that the real graph does not get (caught in
 * review on PR #2280).
 *
 * index.ts:515-524 is a second import statement from ./lib/self-update.js,
 * already listed once below — ESM evaluates a module once per process, so
 * listing it twice would measure nothing extra.
 *
 * `node:os` is deliberately absent though index.ts:13 declares it: nothing in
 * index.ts references `os`, so tsc elides it (dist/index.js:8-13 has no os
 * import). platform/index.js is elided from the entry for the same reason —
 * index.ts:211 binds IS_WINDOWS and nothing uses it, so `platform/index.js`
 * appears nowhere in dist/index.js — but unlike `os` it stays in this list,
 * because the graph loads it anyway one level down (self-update.ts:21,
 * agents.ts:22). Its row below is labelled accordingly. This list is the graph
 * the built entry actually loads, not the one the source appears to declare.
 */
const BOOTSTRAP_GRAPH: string[] = [
  'commander', // index.ts:10
  'chalk', // index.ts:11
  'node:fs', 'node:path', 'node:url', // index.ts:12, 14, 15
  dist('lib/startup/dev-build.js'), // index.ts:16
  dist('lib/secrets/sync-commands.js'), // index.ts:36
  dist('lib/self-update.js'), // index.ts:86-95 (and again at index.ts:515-524)
  dist('lib/startup/command-registry.js'), // index.ts:124-207
  dist('lib/help.js'), // index.ts:208
  dist('lib/whats-new.js'), // index.ts:209
  dist('lib/platform/index.js'), // declared at index.ts:211 but elided; really loaded via self-update.ts:21 / agents.ts:22
  dist('lib/cli-entry.js'), // index.ts:212
  dist('lib/events.js'), // index.ts:213
  dist('lib/event-provenance.js'), // index.ts:214
  dist('lib/format.js'), // index.ts:215
  dist('lib/state.js'), // index.ts:513
  dist('lib/brand.js'), // index.ts:514
];

const SPAWN_OPTS = { time: 3000, iterations: 12 } as const;

describe('startup module loading — one cold `node -e "await import(...)"` per index.ts eager import (index.ts:10-215)', () => {
  bench('BASELINE: bare `node -e ""` — the spawn floor every row below also pays; subtract it to get load cost', () => {
    coldImport([]);
  }, SPAWN_OPTS);

  bench('commander (index.ts:10)', () => {
    coldImport(['commander']);
  }, SPAWN_OPTS);

  bench('chalk (index.ts:11)', () => {
    coldImport(['chalk']);
  }, SPAWN_OPTS);

  bench('node:fs + node:path + node:url (index.ts:12, 14, 15) — builtins, snapshot-resident; index.ts:13 `os` is unused and tsc elides it (absent from dist/index.js:8-13)', () => {
    coldImport(['node:fs', 'node:path', 'node:url']);
  }, SPAWN_OPTS);

  bench('lib/startup/dev-build.js (index.ts:16)', () => {
    coldImport([dist('lib/startup/dev-build.js')]);
  }, SPAWN_OPTS);

  bench('lib/secrets/sync-commands.js (index.ts:36) — the leaf the docblock at index.ts:58-61 says is cheap to bind here', () => {
    coldImport([dist('lib/secrets/sync-commands.js')]);
  }, SPAWN_OPTS);

  bench('lib/self-update.js (index.ts:86-95) — pulls lib/versions.js via self-update.ts:20', () => {
    coldImport([dist('lib/self-update.js')]);
  }, SPAWN_OPTS);

  bench('lib/startup/command-registry.js (index.ts:124-207) — every COMMAND_LOADERS entry is a dynamic import inside a thunk (command-registry.ts:32-119), so the table itself loads no command module', () => {
    coldImport([dist('lib/startup/command-registry.js')]);
  }, SPAWN_OPTS);

  bench('lib/help.js (index.ts:208)', () => {
    coldImport([dist('lib/help.js')]);
  }, SPAWN_OPTS);

  bench('lib/whats-new.js (index.ts:209)', () => {
    coldImport([dist('lib/whats-new.js')]);
  }, SPAWN_OPTS);

  bench('lib/platform/index.js — `export *` barrel over paths/exec/links/process/ipc/winpath (platform/index.ts:19-24); index.ts:211 binds IS_WINDOWS but nothing uses it so tsc elides that edge, and the graph reaches it via self-update.ts:21 / agents.ts:22 instead', () => {
    coldImport([dist('lib/platform/index.js')]);
  }, SPAWN_OPTS);

  bench('lib/cli-entry.js (index.ts:212)', () => {
    coldImport([dist('lib/cli-entry.js')]);
  }, SPAWN_OPTS);

  bench('lib/events.js (index.ts:213) — pulls lib/state.js + lib/fs-atomic.js (events.ts:20-21)', () => {
    coldImport([dist('lib/events.js')]);
  }, SPAWN_OPTS);

  bench('lib/event-provenance.js (index.ts:214)', () => {
    coldImport([dist('lib/event-provenance.js')]);
  }, SPAWN_OPTS);

  bench('lib/format.js (index.ts:215) — re-enters the events graph via format.ts:12', () => {
    coldImport([dist('lib/format.js')]);
  }, SPAWN_OPTS);

  bench('lib/state.js (index.ts:513) — imported directly, not only via events.ts:21', () => {
    coldImport([dist('lib/state.js')]);
  }, SPAWN_OPTS);

  bench('lib/brand.js (index.ts:514) — the SECOND edge to lib/versions.js: brand.ts:20 -> agents.js, agents.ts:26 -> versions.js', () => {
    coldImport([dist('lib/brand.js')]);
  }, SPAWN_OPTS);
});

/**
 * The graphs, not the pieces. Individual rows above double-count shared
 * subgraphs (state.js is reached from events.js, format.js AND index.ts:513
 * directly; platform/index.js from self-update.js and directly), so their sum is
 * not the real cost. These rows import a whole graph in ONE child, which is what
 * an invocation pays.
 *
 * lib/versions.js — 3738 lines, and the single largest thing in the graph —
 * enters by TWO independent edges, which is the point of the rows below:
 *
 *   index.ts:86-95  -> self-update.ts:20  -> versions.js   (a re-export shim)
 *   index.ts:514    -> brand.ts:20        -> agents.js -> agents.ts:26 -> versions.js
 *
 * The first edge is removable on one line: versions.ts does not define
 * `compareVersions`, it re-exports it (versions.ts:34, note at
 * versions.ts:2327-2328) from agent-spec/primitives.ts:50, a file with zero
 * imports. The second is NOT — agents.ts:26 imports three real functions
 * (resolveVersion, getVersionHomePath, getBinaryPath; versions.ts:2205, :1126,
 * :1006), and brand.js cannot be deferred because resolveBrandName() is called
 * at module scope (index.ts:241), as is getUpdateCheckPath() from state.js
 * (index.ts:525).
 *
 * agents.js is the sole waypoint for that second edge, and it has two feeders:
 * brand.ts:20 and capabilities.ts:11. Both therefore reach versions.js, which is
 * why cutting agents.ts:26 — not deferring brand.js — is what the third row
 * measures.
 *
 * So `oneEdgeCut` measures what cutting ONLY the easy edge buys — the honest
 * answer being "almost nothing", because the other edge still pulls the same
 * module. `bothEdgesCut` measures the headroom if agents.ts:26 were also cut:
 * it substitutes agents.js's own imports (agents.ts:12-27) MINUS the versions.js
 * edge, so it is a real measured lower bound on that graph, not arithmetic.
 *
 * `deferrable` additionally drops events.js / event-provenance.js / format.js.
 * Every symbol index.ts binds from those three is called only inside a function
 * body, never at module scope: emit (index.ts:292, 314) and redactArgs
 * (index.ts:298) inside the preAction/postAction hooks, stampProvenance
 * (index.ts:337) inside postAction, emitFriction (index.ts:942) inside the
 * `_internal friction` action, die (index.ts:919) inside the `hq` tombstone
 * action. state.js stays regardless — index.ts:513 imports it directly.
 *
 * `floor` is the irreducible cost: commander + chalk + the builtins, which the
 * CLI cannot start without.
 */
const SELF_UPDATE_REDIRECTED: string[] = [
  'node:fs', 'node:os', 'node:path', 'node:crypto', 'node:child_process', // self-update.ts:15-19
  dist('lib/agent-spec/primitives.js'), // where compareVersions is defined (primitives.ts:50)
  dist('lib/platform/index.js'), // self-update.ts:21
];
/**
 * agents.ts:12-27 minus the one `./versions.js` edge at agents.ts:26.
 *
 * capabilities.js (agents.ts:27) is deliberately excluded, and that exclusion is
 * the whole subtlety of this row. capabilities.ts:11 imports `./agents.js` and
 * nothing else local, so as BUILT today `capabilities.js -> agents.js ->
 * versions.js` — importing it here would silently re-add the exact module this
 * row exists to remove, and the row would measure nothing (it initially did: it
 * came out SLOWER than TODAY). In the counterfactual where agents.ts:26 is gone,
 * capabilities.js's only edge leads to an agents.js that carries no versions.js,
 * so it contributes nothing beyond what this list already holds.
 */
const AGENTS_WITHOUT_VERSIONS: string[] = [
  'node:child_process', 'node:util', 'node:crypto', 'node:fs', 'node:path', 'node:os', // agents.ts:12-17
  'smol-toml', 'yaml', 'chalk', // agents.ts:18-20
  dist('lib/platform/index.js'), // agents.ts:22
  dist('lib/fs-walk.js'), // agents.ts:23
  dist('lib/fuzzy.js'), // agents.ts:24
  dist('lib/state.js'), // agents.ts:25
];
const WITHOUT_SELF_UPDATE = BOOTSTRAP_GRAPH.filter((s) => !s.endsWith('self-update.js'));
const ONE_EDGE_CUT = [...WITHOUT_SELF_UPDATE, ...SELF_UPDATE_REDIRECTED];
const BOTH_EDGES_CUT = [
  ...ONE_EDGE_CUT.filter((s) => !s.endsWith('brand.js')),
  ...AGENTS_WITHOUT_VERSIONS,
];
const DEFERRABLE_GRAPH = BOTH_EDGES_CUT.filter(
  (s) => !s.endsWith('events.js') && !s.endsWith('event-provenance.js') && !s.endsWith('format.js'),
);
const FLOOR_GRAPH = ['commander', 'chalk', 'node:fs', 'node:path', 'node:url'];

describe('startup module loading — the whole eager graph in one cold process (what every `agents` invocation actually pays before argv is read)', () => {
  bench('BASELINE: bare `node -e ""` — same spawn floor as the rows below', () => {
    coldImport([]);
  }, SPAWN_OPTS);

  bench('TODAY: the full graph (index.ts:10-215 AND index.ts:513-524)', () => {
    coldImport(BOOTSTRAP_GRAPH);
  }, SPAWN_OPTS);

  bench('ONE EDGE CUT: self-update.ts:20 redirected to agent-spec/primitives.js — versions.js still arrives via index.ts:514 -> brand.ts:20 -> agents.ts:26', () => {
    coldImport(ONE_EDGE_CUT);
  }, SPAWN_OPTS);

  bench('BOTH EDGES CUT: that plus agents.ts:26 no longer importing versions.js (agents.ts:12-27 substituted without it) — the headroom, and the only shape where versions.js leaves the graph', () => {
    coldImport(BOTH_EDGES_CUT);
  }, SPAWN_OPTS);

  bench('...and events.js + event-provenance.js + format.js deferred into the hook bodies that use them (state.js stays: index.ts:513)', () => {
    coldImport(DEFERRABLE_GRAPH);
  }, SPAWN_OPTS);

  bench('FLOOR: commander + chalk + builtins only — what the CLI cannot start without', () => {
    coldImport(FLOOR_GRAPH);
  }, SPAWN_OPTS);
});

/**
 * The command modules COMMAND_LOADERS imports once a top-level name is resolved
 * (index.ts:1271-1280 -> command-registry.ts:32-119). These load AFTER the
 * bootstrap graph above and are the larger half of a real cold start, so the
 * last row measures one on TOP of the bootstrap graph — the true marginal cost
 * of `agents view` over the bootstrap the process already paid, not a number
 * measured in isolation and assumed to add.
 */
const COMMAND_MODULE_OPTS = { time: 6000, iterations: 12 } as const;

describe('startup module loading — command modules pulled by COMMAND_LOADERS (command-registry.ts:32-119)', () => {
  bench('BASELINE: bare `node -e ""` — same spawn floor as the rows below', () => {
    coldImport([]);
  }, COMMAND_MODULE_OPTS);

  bench('commands/view.js (loadView, command-registry.ts:32)', () => {
    coldImport([dist('commands/view.js')]);
  }, COMMAND_MODULE_OPTS);

  bench('commands/doctor.js (loadDoctor, command-registry.ts:65)', () => {
    coldImport([dist('commands/doctor.js')]);
  }, COMMAND_MODULE_OPTS);

  bench('commands/sessions.js (loadSessions, command-registry.ts:107) — the SQLite-backed session stack', () => {
    coldImport([dist('commands/sessions.js')]);
  }, COMMAND_MODULE_OPTS);

  bench('bootstrap graph THEN commands/view.js — the real `agents view` module-load path, in order', () => {
    coldImport([...BOOTSTRAP_GRAPH, dist('commands/view.js')]);
  }, COMMAND_MODULE_OPTS);
});
