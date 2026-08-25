---
kind: report
template: report.v1
title: Who owns session state — a survey of every writer of sessions.db
summary: >-
  The write API is single and properly locked. Ownership is not: 28 files trigger the
  scanner, 8 modules write session rows, and the daemon is one participant rather than
  the owner. Nothing owns creation, and nothing owns "is this still alive".
header: AGI CLI · session ownership
footer: Phoenix Labs
project: agents-cli
context: >-
  Owner asked whether the daemon should own all session management — creation, orphan
  detection, metadata, sessions.db writes — and said the current logic is not well
  implemented. Surveyed from source.
repository: phnx-labs/agents-cli
branch: plan/reconnect-architecture
surface: cli
tracking: RUSH-3125
status: draft
harness: claude
agent: claude
human: Muqsit
host: zion
session: e9b853bc
date: '2026-08-25'
facts:
  - 'db.ts is a single write API — 76 write statements, WAL, busy_timeout, BEGIN IMMEDIATE, a scan claim'
  - '28 non-test files call discoverSessions, the scanner that upserts the index'
  - '8 production modules write session rows; 27 import the db API'
  - 'The daemon warms the index every 20s and active sessions every 15s — it is a real scheduler already'
  - 'No module owns session CREATION: hosts, cloud and fork each register rows independently'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Summary

Your instinct is right, but the problem is not the one it sounds like. There **is** a
single write API and it is properly concurrency-controlled — this is not a free-for-all
of raw SQL. What is missing is **ownership**: the index is maintained as a side effect of
whichever command you happen to run, the daemon is one participant among ~28 rather than
the authority, and two responsibilities have no owner at all — session **creation** and
**"is this still alive"**.

<aside class="artifact-callout"><strong>Method correction, because it matters:</strong>
my first pass through this used <code>grep</code>, which is aliased to <code>ugrep</code>
on this box and was silently returning empty where it should have returned <code>0</code>.
That produced a false finding — that <code>discover.ts</code> bypasses <code>db.ts</code>
and writes raw SQL. It does not; it imports the API and calls
<code>upsertSessionsBatch</code>. Everything below was re-derived with Python and is
counted, not eyeballed.</aside>

## Findings

### The write API is single, and it is defended

`lib/session/db.ts` is the only module with SQL against `sessions.db` — **76 write
statements**. It carries real concurrency control, not hope:

| Mechanism | Count |
| --- | --- |
| `BEGIN IMMEDIATE` | 2 |
| `busy_timeout` | 4 |
| WAL mode | 3 |
| `SCAN_CLAIM` | 3 |

And `discover.ts` — the scanner — carries 18 `claim` and 27 `lock` references, plus 7
mentions of concurrency. Multiple writers were anticipated and guarded.

**So the thing to fix is not data corruption.** It is that nobody is in charge.

### Ownership is diffuse — the index is a side effect

Counted across the tree, excluding tests and benches:

| Measure | Count |
| --- | --- |
| Files calling `discoverSessions` (the scanner that upserts) | **28** |
| Modules importing the sessions db API | **27** |
| Production modules that write session rows | **8** |

Every one of those 28 call sites refreshes the index as a byproduct of doing something
else — `focus`, `resume`, `render`, `output`, `insights`, `trace`, `browser`, `go`,
`cost`, `export`, `migrate`, `logs`, `feed`, `teams`. Run `agents sessions render` and you
pay for a scan. Run nothing, and the index only stays fresh because the daemon happens to
be ticking.

The eight modules that write session rows:

```
lib/session/discover.ts        upsertSessionsBatch, recordScans, recordDirScans
lib/hosts/session-index.ts     upsertSession          (remote --device dispatch)
lib/cloud/session-index.ts     upsertSession          (cloud runs)
lib/session/fork.ts            upsertSession          (fork)
commands/insights.ts           writeSessionInsights
commands/sessions-picker.ts    writeSessionPreviewCache
commands/sessions-backfill.ts  backfillResourceUsage
lib/browser/service.ts +
lib/computer/actions.ts        recordBrowserSession / recordComputerSession
```

Note the top four: **session creation has no single entry point.** A remote dispatch, a
cloud run, and a fork each independently decide what a new session row looks like. There
is no `createSession` that all three go through, so any invariant about a new row — that
it carries a machine, an origin, a launch id — has to be re-established in three places
and can drift in three places.

### The daemon already does more than I gave it credit for

From `lib/daemon/daemon.ts`, the real tick schedule:

| Tick | Interval |
| --- | --- |
| `runActiveSessionsWarmTick` | **15s** |
| `runSessionIndexWarmTick` | **20s** |
| `runWatchdogTick` | 3 min |
| `runDeviceProbeTick` | 3 min |
| `runMonitorTick` | 60s |
| `reapDeadTmuxPanes` | 5 min |
| `reapAbandoned` (browser tasks) | 5 min |
| `reapOrphanedKeychainProcesses` | 5 min |
| `reapOrphanedProcesses` | 5 min |
| self-heal | 6 h |

It is already a real per-device scheduler with a pid claim that stops it double-firing.
It warms the index every 20 seconds. So "the daemon does nothing" would be wrong.

**But warming is not owning.** The daemon runs the same scanner every command runs, on a
timer. It is participant #1 of 28, not the authority. Concretely, that means:

- the same scan work is paid many times over, by whoever happens to invoke a command
- freshness depends on the claim/lock layer arbitrating a crowd, rather than on there
  being one writer
- there is no single place to add an invariant, a repair, or a state transition, because
  there is no single place that owns the transition

### What has no owner at all

Three responsibilities, each currently nobody's:

1. **Creation.** Three independent registrars (hosts / cloud / fork). No shared contract.
2. **Liveness.** The watchdog covers **stalled** (alive, not progressing). Nothing covers
   **detached** — alive with no client attached. That is the reconnect gap from RUSH-3180,
   seen from the data side: there is no state to write even if something noticed.
3. **Boot.** Nothing reconciles at daemon start. After a reboot, sessions that were
   running on peers are still running — and no pass exists to find them, mark them, or
   surface them.

## Evidence

Counts produced by walking the tree in Python (excluding `*.test.ts`, `*.bench.ts`,
`node_modules`, `dist`), resolving each write function to its production callers:

```
=== production callers of each WRITE function ===
  upsertSession:            lib/cloud/session-index.ts
                            lib/hosts/session-index.ts
                            lib/session/fork.ts
  upsertSessionsBatch:      lib/session/discover.ts
  recordScans:              lib/session/discover.ts
  recordDirScans:           lib/session/discover.ts
  writeSessionInsights:     commands/insights.ts
  writeSessionPreviewCache: commands/sessions-picker.ts
  backfillResourceUsage:    commands/sessions-backfill.ts
  updateSessionFilePaths:   commands/versions.ts
                            lib/installations/shims.ts
                            lib/installations/versions.ts
  recordBrowserSession:     lib/browser/service.ts
  recordComputerSession:    lib/computer/actions.ts
```

`lib/session/discover.ts` is 5,684 lines and holds the scan/parse/upsert path for every
harness. It imports `./db.js` and `../sqlite.js`, and contains **zero** raw
`INSERT`/`UPDATE`/`DELETE` — all persistence goes through the API.

## Recommendation

**Make the daemon the writer, and make every other path a reader or a request.**

Not "the daemon does more ticks" — a narrowing of who may write:

1. **One `createSession` contract.** Hosts, cloud and fork call it instead of each
   building a row. That is where machine/origin/launch-id invariants get enforced once.
2. **The daemon owns the scan.** Commands read the index and may *request* a refresh;
   they stop scanning inline. The claim layer stays as a backstop, but stops being the
   thing correctness rests on.
3. **A session state machine with an owner** — `running` → `stalled` → `detached` →
   `done`/`orphaned` — where the daemon is the only writer of the transition, and every
   surface (`sessions`, Fleet, notifications) is a projection of it.
4. **A boot reconciliation pass.** On daemon start, probe what this device launched onto
   peers and reconcile. That is the reboot case, and it is the one where recovery is free
   and currently never happens.
5. **Keep action user-initiated.** The daemon writes state and offers verbs; it must not
   spawn or reopen on its own — that is the 2026-08-03 double-fire incident.

Sequencing matters: (1) and (3) are cheap and unlock the rest. (2) is the invasive one —
28 call sites — and should follow, not lead.
