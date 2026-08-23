---
kind: plan
surface: cli
title: "Session preview: show the machinery a session left running"
summary: >
  A session that spawns sub-agents, backgrounds shells, or arms monitors leaves
  machinery behind, and the preview under-reports all three. Sub-agent fan-out is
  shown locally but vanishes on remote rows; background shells are never shown;
  monitors cannot be attributed to a session at all. One extractor, two persisted
  columns, and both render paths fix it. Combines RUSH-3091 and RUSH-3095.
status: awaiting-go
facts:
  - "sub_agent_count is recomputed per render, never persisted"
  - "tool_calls already holds 3,099 Agent + 14 Task rows fleet-wide"
  - "formatMetaOnlyBody omits subAgentCount entirely — remote rows lose it"
  - "subagent.spawned is declared, counted, and rendered — and never once written"
  - "Codex 0/176 and Droid 0/126 session files carry any background marker"
links:
  - url: https://linear.app/getrush/issue/RUSH-3091
    label: "RUSH-3091 background shells + monitors"
  - url: https://linear.app/getrush/issue/RUSH-3095
    label: "RUSH-3095 sub-agent fan-out"
---

## Focus for review

- **Scope**: RUSH-3091 and RUSH-3095 planned as one change, because they share the Doing line, the remote-row blind spot, and the same index-time fix.
- **Counts mean "started / left behind", not "running now"** — liveness is deliberately out of scope for v1. Push back if you want live status instead.
- **Codex and Cursor render nothing rather than `0`** — absence, not a lying zero.
- **`subagent.spawned` gets deleted, not an emitter** — a second counting mechanism would disagree with the first.
- **Monitors need a new schema field** and could ship as a second PR.

## Intent

> "when an agent spins up like an agent team or its own subagents internally — do we parse it and store it in the database, and do we also store it in the session preview? because if we don't then we should."

Teams already are first-class. Sub-agents are half-done. Shells and monitors are not done.

## What you see when X

<figure class="artifact-behavior">
  <div data-state="current" data-evidence="capture">
    <svg viewBox="0 0 760 300" role="img" aria-label="Current: agents sessions preview shows 53 sub-agents locally, but the same session viewed remotely shows no fan-out and no shells" xmlns="http://www.w3.org/2000/svg">
      <rect width="760" height="300" rx="8" fill="#0a0a0a"/>
      <text x="20" y="28" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">$ agents sessions preview f045b577          # local, indexed</text>
      <text x="20" y="56" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">  Asked     "[Image: original 3396x1614…"</text>
      <text x="20" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  Doing     ✓9/9 · 53 sub-agents</text>
      <text x="20" y="96" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">                              ↑ no background shells, no monitors</text>
      <text x="20" y="136" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">$ agents sessions preview f045b577 --device zion   # remote row</text>
      <text x="20" y="164" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">  Asked     "[Image: original 3396x1614…"</text>
      <text x="20" y="184" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  Doing     ✓9/9</text>
      <text x="20" y="204" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">                 ↑ fan-out gone entirely — formatMetaOnlyBody</text>
      <text x="20" y="244" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">The local line is a verbatim capture. 53 = 23 Agent calls + 30 shell spawns,</text>
      <text x="20" y="262" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">confirmed by transcript parse and by sqlite3 against sessions.db.</text>
    </svg>
  </div>
  <div data-state="proposed" data-evidence="mockup">
    <svg viewBox="0 0 760 300" role="img" aria-label="Proposed: both local and remote previews show sub-agents, background shells and armed monitors identically" xmlns="http://www.w3.org/2000/svg">
      <rect width="760" height="300" rx="8" fill="#0a0a0a"/>
      <text x="20" y="28" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">$ agents sessions preview f045b577          # local, indexed</text>
      <text x="20" y="56" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">  Asked     "[Image: original 3396x1614…"</text>
      <text x="20" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  Doing     ✓9/9 · 53 sub-agents · 3 background shells · 2 monitors armed</text>
      <text x="20" y="116" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">$ agents sessions preview f045b577 --device zion   # remote row</text>
      <text x="20" y="144" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">  Asked     "[Image: original 3396x1614…"</text>
      <text x="20" y="164" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  Doing     ✓9/9 · 53 sub-agents · 3 background shells · 2 monitors armed</text>
      <text x="20" y="184" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">                 ↑ identical — counts come from persisted columns</text>
      <text x="20" y="224" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">$ agents sessions preview &lt;codex-id&gt;              # unsupported harness</text>
      <text x="20" y="252" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  Doing     ✓4/6 · 2 sub-agents</text>
      <text x="20" y="272" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">                 ↑ no shells segment at all — absence, never "0 shells"</text>
    </svg>
  </div>
</figure>

## Why remote rows lose it

Two render paths exist. Only one of them parses events, and only that one can derive a
count. Everything the preview derives from events is invisible to the other.

<figure>
  <svg viewBox="0 0 780 340" role="img" aria-label="Data flow: transcript to two render paths, showing the derived path works and the meta-only path has no source" xmlns="http://www.w3.org/2000/svg">
    <rect width="780" height="340" rx="8" fill="#0a0a0a"/>

    <rect x="24" y="40" width="150" height="66" rx="6" fill="#14210a" stroke="#a3e635" stroke-width="1"/>
    <text x="99" y="66" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="#a3e635">transcript</text>
    <text x="99" y="86" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">.jsonl on disk</text>

    <rect x="24" y="150" width="150" height="66" rx="6" fill="#0f1a24" stroke="#38bdf8" stroke-width="1"/>
    <text x="99" y="176" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="#38bdf8">sessions.db</text>
    <text x="99" y="196" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">columns + tool_calls</text>

    <rect x="300" y="40" width="180" height="66" rx="6" fill="#1a1a1a" stroke="#666" stroke-width="1"/>
    <text x="390" y="66" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="#e8e8e8">digest body</text>
    <text x="390" y="86" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">parses events</text>

    <rect x="300" y="150" width="180" height="66" rx="6" fill="#1a1a1a" stroke="#666" stroke-width="1"/>
    <text x="390" y="176" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="#e8e8e8">formatMetaOnlyBody</text>
    <text x="390" y="196" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">SessionMeta only</text>

    <rect x="600" y="40" width="150" height="66" rx="6" fill="#14210a" stroke="#a3e635" stroke-width="1"/>
    <text x="675" y="66" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="#a3e635">53 sub-agents</text>
    <text x="675" y="86" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">shown today</text>

    <rect x="600" y="150" width="150" height="66" rx="6" fill="#241012" stroke="#f87171" stroke-width="1"/>
    <text x="675" y="176" text-anchor="middle" font-family="Inter, sans-serif" font-size="12" fill="#f87171">nothing</text>
    <text x="675" y="196" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">remote rows</text>

    <line x1="174" y1="73" x2="298" y2="73" stroke="#a3e635" stroke-width="1.5" marker-end="url(#a)"/>
    <line x1="480" y1="73" x2="598" y2="73" stroke="#a3e635" stroke-width="1.5" marker-end="url(#a)"/>
    <line x1="174" y1="183" x2="298" y2="183" stroke="#38bdf8" stroke-width="1.5" marker-end="url(#b)"/>
    <line x1="480" y1="183" x2="598" y2="183" stroke="#f87171" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#c)"/>

    <rect x="300" y="258" width="180" height="52" rx="6" fill="#14210a" stroke="#a3e635" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="390" y="280" text-anchor="middle" font-family="Inter, sans-serif" font-size="11" fill="#a3e635">NEW: persisted columns</text>
    <text x="390" y="298" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">sub_agent_count, bg_shells</text>
    <line x1="99" y1="216" x2="99" y2="284" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="4 3"/>
    <line x1="99" y1="284" x2="298" y2="284" stroke="#a3e635" stroke-width="1.5" marker-end="url(#a)"/>
    <line x1="390" y1="256" x2="390" y2="220" stroke="#a3e635" stroke-width="1.5" marker-end="url(#a)"/>

    <defs>
      <marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#a3e635"/></marker>
      <marker id="b" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#38bdf8"/></marker>
      <marker id="c" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#f87171"/></marker>
    </defs>
  </svg>
  <figcaption>Read top row first: transcript → digest body → the count you see today. Bottom row is the same session on another machine — no events, so nothing to derive. The dashed path is the fix: persist at index time so both paths read the same number.</figcaption>
</figure>

## Purpose

Surface work that has **stopped progressing** — the ranking principle the root `AGENTS.md`
states for every attention surface. An idle session that left two shells running and armed a
monitor is the highest-risk state: not advancing, but still holding machinery that nobody is
watching. Today none of that is visible in the preview, and on remote rows even the sub-agent
count disappears. The preview is what a human reads to decide "is this the session I mean?"
before resuming; it should answer "and what did it leave running?".

## Harness support — probed, not assumed

| Harness | Background shells | Evidence |
|---|---|---|
| Claude, Kimi | `Bash` + `run_in_background: true` | live transcripts; Kimi 7/85 files |
| Grok | `run_terminal_command` + `background: true` | 8/400 files; also `kill_command_or_subagent` |
| Codex | none | 0/176 files; `exec_command` records only `cmd` + `workdir` |
| Cursor | not possible | stores only `meta.json` + `prompt_history.json`; tool calls are server-side |
| Droid | none | 0/126 files |

<div class="artifact-callout">
Codex and Cursor must render <strong>no shells segment at all</strong>, never <code>0 background shells</code>. Zero reads as "none running" when the truth is "we cannot know". Precedent in this module: the Hooks line is Claude-only and simply does not render for other harnesses.
</div>

## Proposed Changes

### 1. One extractor — `lib/session/highlights.ts`

`SessionEvent.args` already carries tool input, so both shapes are directly reachable.

```ts
export function extractBackgroundShells(events: SessionEvent[]): BackgroundShell[] {
  const out: BackgroundShell[] = [];
  for (const e of events) {
    if (e.type !== 'tool_use') continue;
    const bg =
      (e.tool === 'Bash' && e.args?.run_in_background === true) ||          // claude, kimi
      (e.tool === 'run_terminal_command' && e.args?.background === true);   // grok
    if (bg) out.push({ command: String(e.args?.command ?? ''), ts: e.timestamp });
  }
  return out;
}
```

Also **move `isSubAgentTool` out of `sessions-picker.ts` into `highlights.ts`** so both renders
share one definition — cross-cutting logic at the source, per the repo's review conventions.
Keep its semantics exactly: in-process `Agent`/`Task` calls **plus** shell-spawned
`agents run` / `teams add`.

### 2. Persist at index time — `lib/session/db.ts`

The module README's own "Gaps to close" already prescribes this for sub-agent count (#9).
Follow the established guarded-migration pattern (`spawned_team`, `db.ts:768`):

```sql
ALTER TABLE sessions ADD COLUMN sub_agent_count INTEGER;
ALTER TABLE sessions ADD COLUMN background_shell_count INTEGER;
```

Write them in the same scan path that already writes `is_team_origin` / `spawned_team`
(`db.ts:1746`). **This is the part that fixes remote rows.**

### 3. Render on both paths — `commands/sessions-picker.ts`

```
formatMetaOnlyBody (555-568)   add both counts, read from persisted columns
digest body        (837-845)   prefer persisted, fall back to derived
```

The prefer-persisted/fall-back shape mirrors `recentDirectoriesTouched`, already documented
in the module README.

### 4. Delete the dead `subagent.spawned` event

Declared (`event-stream.ts:48`, `:118`), counted (`feed/activity.ts:409`), given a glyph
(`activity.ts:480`) — and never written once:

```bash
grep -rh "subagent.spawned" ~/.agents/.history/events | wc -l
# 0
```

Delete rather than add an emitter: an emitter creates a second counting mechanism that can
disagree with the tool-call derivation. That divergence is already observable on `f045b577` —
23 tool calls, 46 sub-agent transcript files on disk, 53 reported. One derivation only.

### 5. Monitors — needs a schema field first

`~/.agents/monitors/*.yml` carries interval, last check, fire count and action, but **no
session attribution**. Stamp the arming session id at `agents monitors add` time, then join.
Do not backfill by scraping prompt prose. This is the natural second PR.

## Files

| File | Change |
|---|---|
| `apps/cli/src/lib/session/highlights.ts` | new `extractBackgroundShells`; receives `isSubAgentTool` |
| `apps/cli/src/lib/session/db.ts` | two guarded `ALTER TABLE`s + write in the scan path |
| `apps/cli/src/commands/sessions-picker.ts` | render both counts on **both** body paths |
| `apps/cli/src/lib/event-stream.ts`, `lib/feed/activity.ts` | delete `subagent.spawned`, `subagentCount` |
| `apps/cli/src/lib/session/README.md` | correct row #9 — the count IS derivable from `tool_calls` |
| `apps/cli/docs/`, `CHANGELOG.md` | user-visible preview change |

## Public Interface

Two new persisted columns on `sessions`, and one new Doing-line segment. No new command, no
new flag.

```text
sessions.sub_agent_count         INTEGER   nullable — NULL means "not yet scanned",
sessions.background_shell_count  INTEGER   distinct from 0 meaning "none found"
```

The rendered contract, in the order segments appear on the Doing line:

```text
Doing     ✓9/9 · <team lineage> · N sub-agents · N background shells · N monitors armed
```

Each segment is omitted entirely when its count is zero **or** when the harness cannot report
it. `--json` consumers gain the two fields with the same nullable semantics; an absent field
means unknown, never zero.

## Liveness — out of scope for v1

A transcript records that a shell was *started*, never that it is still alive. Inferring
liveness from transcript presence is the trap `agents devices ps` already documents: a killed
process never writes its `.exit` file, so a naive reader reports "running" forever. Task
output files also live under `/tmp` and are wiped, so they prove nothing historically.

v1 reports **"left N background shells"**. Live reconciliation belongs in `sessions --active`,
where real pids are already resolved.

## Validation

| Check | How |
|---|---|
| Extractor, per harness | Unit tests over committed fixtures: Claude `run_in_background`, Grok `background`, plus a **Codex fixture asserting the field is absent, not zero** |
| No regression on the known session | `f045b577` still reports 53 after `isSubAgentTool` moves |
| The actual bug | Render that session through `formatMetaOnlyBody` and assert both counts appear — **this test fails on today's code** |
| Migration idempotent | Scan twice against a copy of the real 2.3 GB `sessions.db`; second run is a no-op |
| Remote parity | Compare local and `--device` preview of the same id; they must agree |
| Dead event gone | `grep -r subagent.spawned` returns nothing outside the CHANGELOG |

```bash
cd apps/cli && bun run test
agents-dev sessions preview f045b577
agents-dev sessions preview f045b577 --device zion    # must match
```

## Risks

| Risk | Mitigation |
|---|---|
| Migration touches a 2.3 GB live DB | Guarded `ALTER TABLE` following the exact `spawned_team` precedent; nullable columns, no rewrite of existing rows; idempotency asserted against a copy before it runs for real |
| `NULL` read as `0`, so "not scanned" renders as "no shells" | Nullable is load-bearing: the render omits the segment on `NULL` and on `0` alike, so neither can produce a false "none running" claim |
| Moving `isSubAgentTool` silently changes the count | Pinned by a regression test on `f045b577` — must still be 53 (23 `Agent` + 30 shell spawns), verified two independent ways before the move |
| Deleting `subagent.spawned` breaks a consumer | It has none: zero events ever written, and `CollapsedActivity.subagentCount` is therefore always 0 for every caller. Grep-verified across the whole event store |
| Counts read as live status | Wording is "left N background shells", never "running"; liveness explicitly deferred rather than guessed |

## Tracking

- [RUSH-3091](https://linear.app/getrush/issue/RUSH-3091) — background shells + armed monitors
- [RUSH-3095](https://linear.app/getrush/issue/RUSH-3095) — sub-agent fan-out, remote rows, dead event
