---
kind: plan
template: plan.v1
title: One daemon per device, and how N of them make one fleet
summary: >-
  Three roles — producer, coordinator, consumer — currently misassigned. The fleet
  coordinator lives in the VS Code extension, not the daemon. Four state classes, one
  ownership rule, and conflicts become impossible by construction.
header: AGI CLI · daemon federation
footer: Phoenix Labs
project: agents-cli
context: >-
  Owner: most features belong at the daemon level, including tab naming. The daemon is
  the single source of truth. But a daemon runs on every device — how do N of them
  coordinate? Design must be clean and answer all of it.
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
  - 'The daemon does NOT run watchFleetFeed — the extension elected window owns that subprocess'
  - 'watchFleetFeed already implements per-device federation: one SSH stream per peer, each answering --local only'
  - 'Tab naming lives in ~215 references across 12 extension files, none in the CLI'
  - 'Unreachable peers are already explicit in the protocol (scope: unavailable), not silently absent'
  - 'Usage already uses the elected-singleton pattern via account-state-service.ts'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Purpose

You asked for a clean design answering: if the daemon is the single source of truth, and
a daemon runs on **every** device, how do N of them form one fleet without stepping on
each other?

The short answer: **they never step on each other, because no daemon ever writes another
device's facts.** Conflict is impossible by construction, not by locking. The only state
that needs arbitration is the small set that is genuinely fleet-wide, and that already has
a pattern.

But there is a finding first, and it is the one that matters.

### The coordinator is in the wrong process

`watchFleetFeed` (`apps/cli/src/lib/feed/watch.ts`) is the fleet federation, and it is
**good** — one persistent SSH stream per peer, each peer running `agents feed watch
--local` and answering only for itself. Exactly the shape you'd want.

It is called from **one place**: `apps/cli/src/commands/feed-watch.ts`. Nothing in
`lib/daemon/daemon.ts` references it. And `apps/ext/AGENTS.md` makes that official:

> The **elected extension monitor** owns one `agents feed watch --json` child across
> editor windows.

So today the thing that unions the fleet is a subprocess **owned by VS Codium**. Close the
editor and nobody is coordinating. That is precisely the inversion you called out — the
JavaScript application running what the daemon should run.

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> the federation
mechanism already exists and is well designed. It is simply hosted by the wrong process.
Moving the coordinator into the daemon is a relocation, not a rewrite.</aside>

## Proposed Changes

### Three roles, cleanly separated

| Role | Responsibility | Should be | Is today |
| --- | --- | --- | --- |
| **Producer** | Owns one device's truth. Answers `--local` only. | that device's daemon | partly — daemon ticks, but 28 commands also scan, and the pid map is write-once |
| **Coordinator** | Unions producers into a fleet view. One per consuming machine. | that machine's daemon | **the VS Codium extension** |
| **Consumer** | Renders. Produces nothing. | ext, menubar, CLI | ext also produces (tab names, identity fetches — agi-cli#3019) |

One sentence each:

- A **producer** may write only facts about processes it can see with a local syscall.
- A **coordinator** may only union and cache; it must never author a fact.
- A **consumer** may only read a projection; if it needs a fact nobody publishes, the fix
  is to publish it, never to go fetch it.

### Four classes of state, and the rule for each

Every fact in the system falls into exactly one. This is the whole multi-device answer.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 940 430" role="img" aria-label="Four state classes across a fleet of daemons">
    <defs>
      <marker id="fa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b8b8b" />
      </marker>
    </defs>

    <text x="20" y="26" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="12">CLASS 1 — device-owned  ·  every daemon produces its own, nobody else's</text>
    <rect x="20" y="38" width="200" height="86" rx="6" fill="#101a0a" stroke="#a3e635" />
    <text x="120" y="60" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">zion daemon</text>
    <text x="120" y="80" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">pid → session</text>
    <text x="120" y="97" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">host-link · tab names</text>
    <text x="120" y="115" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">scope = zion</text>

    <rect x="240" y="38" width="200" height="86" rx="6" fill="#101a0a" stroke="#a3e635" />
    <text x="340" y="60" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">yosemite-s0 daemon</text>
    <text x="340" y="80" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">pid → session</text>
    <text x="340" y="97" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">host-link · tab names</text>
    <text x="340" y="115" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">scope = yosemite-s0</text>

    <rect x="460" y="38" width="200" height="86" rx="6" fill="#101a0a" stroke="#a3e635" />
    <text x="560" y="60" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">yosemite-m4 daemon</text>
    <text x="560" y="80" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">pid → session</text>
    <text x="560" y="97" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">host-link · tab names</text>
    <text x="560" y="115" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">scope = yosemite-m4</text>

    <text x="700" y="60" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="12">Disjoint key space.</text>
    <text x="700" y="80" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="12">No two daemons can</text>
    <text x="700" y="100" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="12">write the same fact.</text>

    <line x1="120" y1="128" x2="300" y2="176" stroke="#8b8b8b" stroke-width="1.4" marker-end="url(#fa)" />
    <line x1="340" y1="128" x2="330" y2="176" stroke="#8b8b8b" stroke-width="1.4" marker-end="url(#fa)" />
    <line x1="560" y1="128" x2="380" y2="176" stroke="#8b8b8b" stroke-width="1.4" marker-end="url(#fa)" />

    <text x="20" y="166" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="12">CLASS 2 — fleet-union  ·  one coordinator per consuming machine, unions, authors nothing</text>
    <rect x="200" y="178" width="360" height="62" rx="6" fill="#0a1520" stroke="#38bdf8" />
    <text x="380" y="200" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="11">watchFleetFeed — one SSH stream per peer</text>
    <text x="380" y="220" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">unreachable peer → scope: unavailable (explicit, never absent)</text>
    <text x="380" y="234" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">today: owned by VS Codium · should be: the daemon</text>

    <text x="20" y="278" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="12">CLASS 3 — elected singleton  ·  exactly one device executes, all read the result</text>
    <rect x="20" y="290" width="430" height="58" rx="6" fill="#1a1206" stroke="#f59e0b" />
    <text x="235" y="312" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">usage · rate limits · anything on a SHARED queue</text>
    <text x="235" y="332" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">owner pin · atomic claim · verified idempotency — the repo already requires one</text>

    <text x="480" y="278" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="12">CLASS 4 — replicated</text>
    <rect x="480" y="290" width="440" height="58" rx="6" fill="#131313" stroke="#4a4a4a" />
    <text x="700" y="312" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">transcripts · config — synced, each device authors only its own</text>
    <text x="700" y="332" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">existing session sync + agents repo push/pull</text>

    <rect x="20" y="366" width="900" height="48" rx="6" fill="#0f0f0f" stroke="#3a3a3a" />
    <text x="40" y="386" fill="#d4d4d4" font-family="JetBrains Mono, monospace" font-size="12">The rule</text>
    <text x="40" y="405" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">No daemon ever writes another device's facts. Class 1 needs no locking; only class 3 needs election.</text>
  </svg>
  <figcaption><b>Figure 1.</b> Class 1 is a disjoint key space, so N daemons never
  conflict. Class 3 is the only place election is required — and it already has a
  mechanism.</figcaption>
</figure>

| Class | Examples | Who writes | Conflict risk |
| --- | --- | --- | --- |
| **1 · device-owned** | pid→session→agent→harness, host-link, session status, tab name, tmux panes | that device's daemon, `--local` only | **none** — disjoint keys |
| **2 · fleet-union** | the combined live view | nobody; the coordinator only unions | none — read-only |
| **3 · elected singleton** | usage / rate limits, ticket tracker, PR queue, feed | exactly one device | real — must elect |
| **4 · replicated** | transcripts, `agents.yaml` | each device authors its own slice | none — per-device slices |

**Why class 1 needs no consensus.** A fact is keyed by the device that owns the process.
`zion` cannot have an opinion about a pid on `yosemite-s0` — it has no syscall that reaches
it. So there is nothing to reconcile. This is also why the current orphan bug exists: zion
*tries* to classify a remote pane, has no signal, and defaults to `connected`. The design
rule makes that a category error rather than a bug to patch.

**Why class 3 is the only hard one** — and the repo already states the rule:

> a job that consumes *shared* input (a ticket tracker, a PR queue, the feed, a sync
> bucket) MUST have exactly one executor per work item: an owner pin, an atomic claim per
> item, or verified idempotency — otherwise two daemons pick the same task and run it
> twice. — root `AGENTS.md`

Usage already complies via `lib/account-state-service.ts`. Nothing new is needed; new
class-3 facts just have to declare which of the three mechanisms they use.

### Tab naming — the worked example

You named it, and it is the cleanest case.

Today: **~215 references across 12 extension files** — `extension.ts` (95),
`terminals.vscode.ts` (66), `terminalReadiness.ts` (14), `remoteAutoLabel.ts`,
`sessionTabLabelSync.ts`. **Zero in the CLI.** The contract even acknowledges the split:

> Editor tabs reconcile their **provisional topic-based auto-labels** from that same
> stream when a harness-owned session `label` arrives; a manual tab label still wins.

So the ext derives a provisional name, then reconciles against a real one. That is two
naming implementations racing, which is why a tab can show one thing and
`agents sessions` another.

**A tab name is a pure function of session state** — topic, agent, host, status. That makes
it **class 1**: the daemon that owns the session computes the name and publishes it in the
row. Every consumer renders the same string. The ext keeps exactly one rule — a manual
label wins — and deletes the derivation.

### Migration order

1. **Publish the name.** Daemon computes `displayName` into the session row. Ext renders it
   when present, keeps its provisional path as fallback. Nothing breaks.
2. **Delete the ext derivation** once the published name covers every case. ~215 refs
   collapse to "render `row.displayName`, unless the user renamed it."
3. **Move the coordinator into the daemon.** The daemon runs `watchFleetFeed` and exposes
   the union over its existing local socket. The ext subscribes instead of spawning. This
   is what closes agi-cli#3019 structurally rather than by throttling.
4. **Producer hardening** — the daemon owns the pid-map lifecycle and the status
   transition (RUSH-3183, RUSH-3180).

Order matters: (1) and (2) are additive and reversible. (3) removes a subprocess the ext
currently depends on, so it goes after the data it needs is provably on the stream.

## Public Interface

```bash
agents feed watch --json          # unchanged for consumers
agents feed watch --local         # unchanged: one device answering for itself
# new: the daemon hosts the coordinator, so the union survives VS Codium being closed
```

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Current — the fleet view lives inside the editor</strong>
<pre><code>VS Codium (elected window)
  └── agents feed watch --json        ← the ONLY fleet coordinator
        ├── ssh yosemite-s0  feed watch --local
        └── ssh yosemite-m4  feed watch --local

  + per remote tab: agents sessions &lt;id&gt; --device &lt;host&gt; --json
       every ~4-5s, forever            ← agi-cli#3019, 2-4 cores</code></pre>
    <p>Close the editor and the fleet view stops existing. Tab names are derived twice —
    once provisionally by the ext, once from the stream.</p>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed — the daemon coordinates, consumers subscribe</strong>
<pre><code>agents daemon (always on, survives reboot)
  └── coordinator: one stream per peer
        ├── ssh yosemite-s0  feed watch --local
        └── ssh yosemite-m4  feed watch --local

VS Codium  ── subscribe ──▶ daemon socket   (no subprocess)
menubar    ── subscribe ──▶ daemon socket
agents CLI ── subscribe ──▶ daemon socket

row.displayName computed once, by the owning daemon</code></pre>
    <p>One coordinator per machine, hosted where it belongs. Tab names are published, not
    re-derived. The per-tab identity fetch has nothing left to fetch.</p>
  </div>
</div>

## Validation

| Check | Expected |
| --- | --- |
| Quit VS Codium entirely | Fleet view still current — daemon is coordinating |
| Tab name in the editor vs `agents sessions` | Identical string, one source |
| Rename a tab manually | Manual label still wins |
| Peer goes offline | `scope: unavailable` with a reason; never a silently missing device |
| Two daemons, same session id | Impossible — only the owning device publishes it |
| `ps` during steady state | No per-tab `agents sessions … --device` processes |

## Risks

| Risk | Mitigation |
| --- | --- |
| Daemon becomes a single point of failure | It is already always-on and pid-claimed; consumers keep the direct CLI path as a degraded fallback for one-shots |
| Moving the coordinator changes ext startup | Steps 1–2 land first and are additive; step 3 only after the data is provably on the stream |
| N peers × one SSH stream each | Already the current cost — this relocates the streams, it does not add any |
| A class-3 fact added without election | Make the class an explicit field, so "which mechanism elects this?" is answered at review time |

## Checklist

- [x] Establish who coordinates the fleet today (the extension, not the daemon)
- [x] Confirm the federation mechanism already exists (`watchFleetFeed`)
- [x] Locate the tab-naming logic (~215 refs, all in the ext)
- [ ] Step 1 — daemon publishes `displayName` on the session row
- [ ] Step 2 — ext renders it; delete the provisional derivation
- [ ] Step 3 — daemon hosts the coordinator; ext subscribes (closes agi-cli#3019)
- [ ] Step 4 — daemon owns the pid map and status transition (RUSH-3183, RUSH-3180)

## Tracking

- [RUSH-3125](https://linear.app/prix/issue/RUSH-3125) · RUSH-3183 · RUSH-3180 · RUSH-3175
- agi-cli#3019 — the per-tab spawn loop this design closes structurally
- Prior session `476c260d` — where the daemon-level requirement was set
