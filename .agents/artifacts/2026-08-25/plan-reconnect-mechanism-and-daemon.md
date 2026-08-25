---
kind: plan
template: plan.v1
title: The fix plan — what we change, in what order, to stop losing agents
summary: >-
  Eight fixes ordered by what they buy you. Six are merged and unshipped, so fix zero is
  shipping them. Everything after is concrete code in named files, no new tickets.
header: AGI CLI · the fix plan
footer: Phoenix Labs
project: agents-cli
context: >-
  Consolidates every requirement from this session into one ordered plan of actual code
  changes. Supersedes the separate surveys and design notes.
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
  - 'Six fixes are merged as ede398c48 and on zero machines — npm is still 1.22.47'
  - 'Reconnect fires only on ssh exiting 255; a closed tab, a crash or a reboot fires nothing'
  - 'classifyHostLink returns connected when it has no signal at all'
  - 'lastActivity ?? timestamp is re-implemented in 7 places, and groups already disagree with the rows inside them'
  - 'Usage is fetched by all 11 devices — 88 provider calls a minute where 8 would do'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Purpose

### What you asked for, from the top

> *"I run agents in VS Codium full-size agent terminals. If there is some slight internet
> disruption then all of my agents basically just exit or timeout. How can we prevent this,
> or have a much nicer reconnection?"*

Everything since has added constraints to that one goal:

| # | Requirement | Where it came from |
| --- | --- | --- |
| R1 | An agent survives a network blink and I get back into **the same agent**, not a replay | the original ask |
| R2 | It is **verified in real VS Codium**, not just unit tests | *"spin up VS Code on zion and actually test it"* |
| R3 | Recovery lives in the **CLI/daemon**, never the extension | *"the daemon is the single point of truth"* |
| R4 | tmux must not break people who already use it, nor confuse people who don't | *"they're gonna have a really hard time using it"* |
| R5 | The daemon owns **all** session management — creation, orphan detection, metadata, `sessions.db` | *"that logic is not very well implemented"* |
| R6 | Device-local jobs and fleet-singleton jobs are **different kinds of job** | *"we need to handle these two different types"* |
| R7 | Usage is fetched **once**, on a stable device, and broadcast | *"we're DDoSing the API"* |
| R8 | Don't change ordering nobody asked for. Status is a **label**; default order is **last activity**, merged across devices | *"why are you changing the order?"* |
| R9 | Ordering must be **trustworthy** — what if last-activity is missing, or the row is remote? | *"what is the guarantee?"* |
| R10 | **Fix things.** Stop producing tickets | *"we just produce slop tickets"* |

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> six fixes for R1 are
already written, reviewed and merged — and running on <strong>zero</strong> machines. Until
1.22.48 publishes, every one of them is inert and R2 cannot even be attempted. That is fix
zero, and it is the only one that needs your hands.</aside>

## Proposed Changes

### Fix 0 — ship what is already built · unblocks R1, R2

`ede398c48` is on `main`, CI green, review approved. npm is still **1.22.47**, and
`resolveTmuxWrap` has **0 occurrences** in your installed CLI. It contains:

| | | Verified by |
| --- | --- | --- |
| F1 | remote `--device` agents detach on the peer, so a blink cannot SIGHUP them | pids gone pre-fix; pane survived post-fix |
| F2 | reconnect keyed off `AGENT_LAUNCH_ID` — every harness, not just Claude | live launch-id resolution |
| F3 | interactive streams off the shared ControlMaster — one blip stops killing every tab | 6 tabs on one socket, observed |
| F4 | 15-minute retry window (was ~90s), countdown, working Ctrl-C | unit |
| F5 | termios + DEC restore, drain gated on abnormal exit | real pty |
| F7 | notices name `agents sessions resume`, not a dead command | unit |

```bash
apps/cli/scripts/release.sh 1.22.48 --apply     # answer the [y/N]
```

Backgrounding it exits 0 publishing nothing (the prompt reads EOF); `--yes` is refused by
the sandbox as an irreversible public publish. **This one is yours.**

Then R2 becomes possible: real VS Codium tab, cut the link for real, watch it rejoin a
**live** pane. That is the one branch still unproven — everything observed so far landed on
*resume*, because there was no pane to attach to.

### Fix 1 — stop reporting "fine" when we know nothing · R5, R9

`lib/session/host-link.ts` falls through to a **blind default**:

```ts
if (input.tmuxClients === 0) return 'no-client';   // authoritative ✓
if (windowGone)              return 'no-client';
return 'connected';                                 // ← no signal at all reads as healthy
```

And `lib/session/active.ts` only promotes it when the session is *already idle*:

```ts
else if (link === 'no-client' && (s.status === 'idle' || s.status === 'input_required')) {
  s.status = 'orphaned';
}
```

**Change:** add `'unknown'` to `HostLink`, returned when there is no usable signal. Drop the
`idle || input_required` gate so a **running** agent with no client is surfaced — that is
the expensive case, still burning tokens. Keep `deliberatelyDetached` first and
`tmuxClients` authoritative; both are correct.

~20 lines across two files. Tests: no-signal → `unknown`; running + no-client → `orphaned`;
detached → `connected` regardless of everything else.

### Fix 2 — one recency function · R8, R9

`lastActivity ?? timestamp` is re-implemented **seven times**, and the duplication has
already shipped a visible bug in `commands/sessions.ts`:

```ts
maxTs: rows[0].lastActivity ?? rows[0].timestamp                      // group: by activity
sessions: rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))   // rows: by CREATION
```

Groups ordered by activity, rows inside them ordered by creation — same command, same
screen.

**Change:** one `lib/session/recency.ts` exporting `recencyOf(session)` implementing the
documented chain — last message ts → file mtime → creation — returning a comparable number,
unparseable sorting last. Delete both private `rowTs()` helpers (`team-filter.ts`,
`trajectory-lineage.ts`), `sessionRecency()` in `commands/reconnect.ts`, and the four inline
occurrences in `commands/sessions.ts`.

**Ordering itself does not change:** last activity, newest first, merged across devices
unless scoped. Status stays a label.

**Remote rows:** the peer computes its own value and ships an ISO string, which
`parseRemoteList` spreads verbatim. ISO is absolute so there is no timezone problem, but
**clock skew is uncorrected** and nothing detects it. `recencyOf` marks a value as
derived-not-measured (mtime or creation, rather than a real message timestamp) so a listing
can show `~` instead of implying precision it does not have.

### Fix 3 — the daemon publishes the name · R3, R5

Tab naming is **~215 references across 12 extension files** and **zero** in the CLI. The ext
derives a provisional label then reconciles against a harness-owned one — two
implementations racing, which is why a tab and `agents sessions` can disagree.

**Change:** the daemon computes `displayName` onto the session row; the ext renders it when
present. Additive — nothing breaks if absent. Then delete the ext derivation, keeping one
rule: a manual rename wins.

### Fix 4 — the daemon owns the orphan, including at boot · R1, R3, R5

This is where R1 actually completes. The reconnect loop fires on **one** trigger — ssh
exiting 255 — and lives **inside** the `agents run` process, so a closed tab, a crash or a
reboot fires nothing. The loop cannot outlive its own process.

**Change:** the daemon writes a `detached` state for a session alive with no client, derived
from a real probe of the pane — never inferred from a missing local client. Plus a **boot
sweep**, because a laptop reboot does not touch a peer's tmux: those agents are still alive
and still attachable, and the daemon is the only component that survives to notice.

Re-attach stays user-initiated. The daemon surfaces and offers; it never reopens a tab.

### Fix 5 — a peer answers for its own sessions · R3, R5

Both host-link signals are local — this box's window registry, this box's tmux. A
`--device` session's pane is on the peer, so the classification is *structurally*
unavailable here. Today that silently becomes `connected`.

**Change:** the peer classifies its own panes and reports it over the existing feed. Not a
local patch — the question was being asked of the wrong machine.

### Fix 6 — usage fetched once · R6, R7

`lib/account-state-service.ts` is documented **"Device-local owner for usage snapshots"**
and every daemon runs it every 60s. 11 devices × 8 accounts = **88 provider calls a minute**
where 8 would do.

`withRefreshLease` already has the right shape — scope, key, acquire, re-read, fetch only if
nobody did, publish, release — including the `readCompleted()` re-check that lets waiters
consume the winner's result for free. What it lacks is a lock reachable from more than one
machine.

**Change:** a fleet-scoped backend for that lease, with acquisition **weighted by device
stability** so an always-on Mac Mini beats a laptop that goes in a backpack, an equal class
never preempts, and the interactive device is the last resort. Snapshots publish with
`fetchedAt` / `fetchedBy` so a follower shows *"usage as of 18s ago, from mac-mini"* rather
than lying or blocking.

### Fix 7 — the coordinator moves into the daemon · R3

`watchFleetFeed` is called from exactly one place, and `apps/ext/AGENTS.md` assigns that
subprocess to *"the elected extension monitor"*. Close VS Codium and nothing unions the
fleet.

**Change:** the daemon hosts it and exposes the union over its socket; the ext subscribes.
This ends the per-tab spawn loop (agi-cli#3019) structurally instead of throttling it.
**Last**, because it removes a subprocess the ext currently depends on.

### On R4 — tmux, and what we are *not* changing

Already correct, verified in `lib/tmux/session.ts`: a **separate socket**, so your own tmux
server and sessions are untouched; and `writeStartupConfig` writes our defaults first then
sources **every** config tmux itself would load, so your bindings win. The one real gap is
that a non-tmux user sees a status bar and a `C-b` they never opted into — a one-line
`status off` default, restorable by anyone who wants it.

## Public Interface

```bash
agents run <agent> --interactive --device <host>   # unchanged
agents sessions                                     # unchanged ORDER; gains a `detached` label
agents sessions --device <name>                     # scope to one device
agents view                                         # never calls the provider on a follower
```

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Current — on your machines right now (1.22.47)</strong>
<pre><code>blink        → agent SIGHUPed on the peer, work lost
grok tab     → no reconnect at all, drops to a shell
6 tabs       → one ControlMaster, all die together
close tab    → agent orphaned, nothing notices
usage        → 88 provider calls/minute
sessions     → groups by activity, rows inside by creation</code></pre>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>After fix 0 (today) and fixes 1–7</strong>
<pre><code>blink        → detached pane survives; reconnect rejoins it
any harness  → reconnects via launch id
6 tabs       → independent connections
close tab    → daemon marks it detached, offers resume
usage        → 8 provider calls/minute, broadcast
sessions     → one recency rule everywhere

$ agents sessions
  claude  yosemite-s0  2m ago   running    Reconnect r…
  grok    yosemite-s0  4m ago   detached   Market
  codex   yosemite-m4  11m ago  running    Dispatch</code></pre>
  </div>
</div>

## Validation

| Check | Expected |
| --- | --- |
| Cut the link in a real VS Codium tab, 1.22.48 both ends | **Attach** — same session id, in-flight turn intact (R1, R2) |
| Same with Grok | Identical (R1) |
| Close the tab mid-run | `detached` within one daemon tick (R5) |
| Reboot zion, agent alive on a peer | Boot sweep surfaces it (R5) |
| Session with no window and no tmux | `unknown`, never `connected` (R9) |
| Group vs rows in `agents sessions` | Same ordering rule for both (R8) |
| Count provider calls fleet-wide, 5 min | 8/min (R7) |
| Existing tmux user's bindings | Unchanged (R4) |

## Risks

| Risk | Mitigation |
| --- | --- |
| Dropping the idle gate creates false orphans | `deliberatelyDetached` stays first; `tmuxClients` authoritative; no-signal becomes `unknown`, not `orphaned` |
| `recencyOf` changes visible order | It implements the *documented* chain; the group-vs-row divergence is the bug being removed, not new behaviour |
| Clock skew across devices | Surface derived values as approximate rather than silently sorting on them |
| Fix 7 breaks ext startup | Goes last, only after the data is provably on the stream |

## Checklist

- [ ] **Fix 0 — publish 1.22.48** ← yours; everything below is inert until this lands
- [ ] Fix 1 — `unknown` + running-can-be-orphaned (`host-link.ts`, `active.ts`)
- [ ] Fix 2 — one `recencyOf()`; delete 7 duplicates; fix the group/row divergence
- [ ] Fix 3 — daemon publishes `displayName`; ext stops deriving
- [ ] Fix 4 — daemon owns `detached` + boot sweep
- [ ] Fix 5 — peers classify their own sessions
- [ ] Fix 6 — fleet-scoped lease for usage; publish with `fetchedAt`/`fetchedBy`
- [ ] Fix 7 — coordinator into the daemon (ends agi-cli#3019)
- [ ] R4 — `status off` default for tmux

## Tracking

- [RUSH-3125](https://linear.app/prix/issue/RUSH-3125) — the umbrella; fixes 1–7 land against it
- Fixes 1 and 2 are independent of the release and can start immediately
