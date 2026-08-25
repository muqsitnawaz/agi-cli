---
kind: plan
template: plan.v1
title: Make the daemon the owner of session state, scoped device-local vs fleet-shared
summary: >-
  The orphan state already exists but defaults to healthy when blind, never fires for a
  running agent, and cannot see across devices. Give one always-on service the pid→session
  map and the state machine, and split every fact by scope: device-local or single-executor.
header: AGI CLI · daemon ownership
footer: Phoenix Labs
project: agents-cli
context: >-
  Owner: the daemon should own all session management — creation, orphan detection,
  metadata, sessions.db. And since the fleet is distributed, some state is device-local
  while some (usage) has exactly one executor and is shared.
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
  - 'classifyHostLink returns connected when it has no signal — a blind default-to-healthy'
  - 'orphaned only fires when status is idle or input_required, so a RUNNING agent with no client never surfaces'
  - 'Host-link signals are local-only, so a remote session cannot be classified from this box'
  - 'The pid→session map is written by exactly one place (lib/exec.ts) at spawn, and never maintained after'
  - 'Usage already has a single-executor service (lib/account-state-service.ts); sessions have no equivalent'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Purpose

You asked two things that turn out to be the same thing.

> *"I don't want to distrust the orphan logic. I know that exists, but how does it actually
> evaluate if something is an orphan or not?"*

> *"Keeping the local PID to session and agent and harness mapping needs to be owned by a
> stable service, robust enough to be restarted, on all the time … some things like usage
> can only be executed from a single device but shared with the fleet; sessions can be
> handled locally per device."*

The orphan logic is **thoughtfully written and structurally blind**. And it is blind for
exactly the reason you identified: nothing owns the mapping it would need to be right.

### How `orphaned` is actually computed — and its four blind spots

`lib/session/host-link.ts` derives a `HostLink` from three inputs, then `active.ts` turns
that into a status:

```ts
export function classifyHostLink(input: HostLinkInput): HostLink {
  if (input.deliberatelyDetached) return 'connected';           // detach is not an orphan ✓
  const windowGone = input.windowHeartbeatMs !== undefined
    && now - input.windowHeartbeatMs >= HOST_HEARTBEAT_STALE_MS;
  if (windowGone && !input.pidAlive) return 'host-gone';
  if (!input.pidAlive)      return 'connected';
  if (input.tmuxClients === 0) return 'no-client';              // authoritative ✓
  if (windowGone)              return 'no-client';
  return 'connected';                                            // ← the blind default
}
```

**What is right:** `tmuxClients === 0` is authoritative — tmux knows exactly how many
clients it has. And a deliberate `agents sessions detach` is excluded *first*, so the one
case that looks identical to an orphan from outside never false-alarms.

**Blind spot 1 — it defaults to healthy.** `windowHeartbeatMs` is absent "for a session no
IDE window owns (a bare terminal, a team spawn, a cloud task)"; `tmuxClients` is absent
when the session is not tmux-hosted. With both absent every branch falls through to
`return 'connected'`. **No signal is reported as fine.**

**Blind spot 2 — a *running* agent is never orphaned.** In `active.ts` the status is only
promoted when the session is already idle:

```ts
else if (link === 'no-client' && (s.status === 'idle' || s.status === 'input_required')) {
  s.status = 'orphaned';
}
```

An agent still working with nobody watching stays `running`. That is precisely your case —
the remote agent burning tokens after your laptop rebooted.

**Blind spot 3 — up to 10 minutes of lag** on the window path (`HOST_HEARTBEAT_STALE_MS`).

**Blind spot 4 — it cannot see across devices.** Both signals are local: the window
heartbeat comes from this box's live-terminals registry, the client count from this box's
tmux. A `--device` session's pane lives on the peer, so this box has neither input and the
classification is structurally unavailable.

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> the orphan state is
not wrong, it is <em>uninformed</em>. It is computed opportunistically from whatever
signals happen to be lying around locally, by whichever command happens to run. Nothing is
responsible for going and getting the answer — which is the ownership gap, stated in data
terms.</aside>

## Proposed Changes

### The organising idea: classify every fact by scope

Your distinction is the right axis, and the codebase already half-implements it — usage has
a single-executor service (`lib/account-state-service.ts`), sessions have no equivalent.

| Fact | Scope | Executor | Shared how |
| --- | --- | --- | --- |
| pid → session → agent → harness | **device-local** | that device's daemon | not shared; each device answers for itself |
| session status / host-link | **device-local** | that device's daemon | published on request via the existing fan-out |
| tmux panes, attached clients | **device-local** | that device's daemon | never shared raw |
| transcripts / `sessions.db` rows | device-local, **synced** | that device's daemon | existing session sync |
| **usage / rate limits** | **fleet-shared** | **exactly one** device | already: `account-state-service.ts` |
| device registry, fleet stats | fleet-shared | publish-own / read-union | already: `fleet status` |

The rule that falls out, and it matches the repo's own contract: **a device answers for its
own processes; nobody answers for anyone else's.** A remote session's orphan status is
computed *by the peer that owns the pane*, then read over the fan-out — never guessed from
here. That is why blind spot 4 is not a bug to patch locally; it is a question asked of the
wrong machine.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 940 400" role="img" aria-label="Scope split: device-local state owned per device, single-executor state shared">
    <defs>
      <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b8b8b" />
      </marker>
    </defs>

    <rect x="20" y="40" width="270" height="200" rx="8" fill="#111" stroke="#4a4a4a" />
    <text x="155" y="66" text-anchor="middle" fill="#d4d4d4" font-family="JetBrains Mono, monospace" font-size="13">zion</text>
    <rect x="38" y="80" width="234" height="46" rx="5" fill="#101a0a" stroke="#a3e635" />
    <text x="155" y="99" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">daemon (always on)</text>
    <text x="155" y="116" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">owns MY pids · MY sessions</text>
    <text x="52" y="152" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">pid → session → agent → harness</text>
    <text x="52" y="172" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">host-link · tmux clients</text>
    <text x="52" y="192" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">sessions.db rows (this device)</text>
    <text x="52" y="220" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">answers only for itself</text>

    <rect x="330" y="40" width="270" height="200" rx="8" fill="#111" stroke="#4a4a4a" />
    <text x="465" y="66" text-anchor="middle" fill="#d4d4d4" font-family="JetBrains Mono, monospace" font-size="13">yosemite-s0</text>
    <rect x="348" y="80" width="234" height="46" rx="5" fill="#101a0a" stroke="#a3e635" />
    <text x="465" y="99" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">daemon (always on)</text>
    <text x="465" y="116" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">owns ITS pids · ITS sessions</text>
    <text x="362" y="152" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">the pane your agent lives in</text>
    <text x="362" y="172" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">so IT computes orphan, not zion</text>
    <text x="362" y="220" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">answers only for itself</text>

    <line x1="290" y1="140" x2="330" y2="140" stroke="#8b8b8b" stroke-width="1.5" marker-end="url(#ar2)" />
    <line x1="330" y1="160" x2="290" y2="160" stroke="#8b8b8b" stroke-width="1.5" marker-end="url(#ar2)" />
    <text x="310" y="132" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="9">ask</text>
    <text x="310" y="180" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="9">answer</text>

    <rect x="640" y="40" width="280" height="200" rx="8" fill="#1a1206" stroke="#f59e0b" stroke-width="1.5" />
    <text x="780" y="66" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="13">fleet-shared, ONE executor</text>
    <text x="780" y="96" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">usage · rate limits · account state</text>
    <text x="780" y="122" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">account-state-service.ts</text>
    <text x="780" y="152" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">fetched by one device,</text>
    <text x="780" y="170" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">read by all of them</text>
    <text x="780" y="204" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">already exists — the pattern to copy</text>

    <rect x="20" y="272" width="900" height="104" rx="8" fill="#0f0f0f" stroke="#3a3a3a" />
    <text x="40" y="298" fill="#d4d4d4" font-family="JetBrains Mono, monospace" font-size="12">The rule</text>
    <text x="40" y="322" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">A device answers for its own processes. Nobody answers for anyone else's.</text>
    <text x="40" y="346" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="12">Today zion tries to classify a session whose pane is on yosemite-s0 — with no window heartbeat and no tmux</text>
    <text x="40" y="364" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="12">client count for it — and falls through to "connected". The question is being asked of the wrong machine.</text>
  </svg>
  <figcaption><b>Figure 1.</b> Scope decides the owner. Device-local facts are answered by
  the device that holds the processes; single-executor facts keep the pattern usage already
  uses.</figcaption>
</figure>

### P1 — one session-state service inside the daemon

The daemon is already always-on, pid-claimed against double-firing, and restartable. Give
it the two things nothing owns:

- **The pid → session → agent → harness map.** Today `lib/exec.ts` writes one registry file
  per spawn (`writePidSessionEntry`) and **nothing maintains it afterwards** — no liveness
  sweep, no reconciliation, no repair. It is a write-once breadcrumb. The daemon should own
  its lifecycle: write, verify, expire, repair.
- **The status transition.** `running → stalled → orphaned → done` becomes a transition the
  daemon computes and writes, rather than a value each command re-derives from whatever
  signals it can see.

### P2 — fix the three local blind spots at the source

- **Stop defaulting to healthy.** `classifyHostLink` returning `connected` with zero inputs
  should become an explicit `unknown`. Callers then distinguish "verified connected" from
  "we have no idea", instead of the second silently reading as the first.
- **Let a running agent be orphaned.** Drop the `idle || input_required` precondition in
  `active.ts`. Whether anyone is watching is independent of whether it is working — and the
  working case is the expensive one.
- **Give bare/team/cloud sessions a signal.** These have no window heartbeat by
  construction. Once every remote interactive run is tmux-wrapped (RUSH-3125), `tmuxClients`
  covers them — so this blind spot largely closes as a side effect, and what remains is
  narrow enough to name.

### P3 — the peer answers for its own sessions

Add the host-link classification to what a peer reports about its own sessions, so a remote
orphan is *reported*, not inferred. The fan-out (`fleet status`, `sessions --active`) already
has the publish-own/read-union shape; this rides it.

### P4 — one `createSession` contract

Three registrars write new rows independently (`hosts/session-index.ts`,
`cloud/session-index.ts`, `session/fork.ts`). One entry point, so machine/origin/launch-id
invariants are enforced once instead of drifting in three places.

### P5 — boot reconciliation

On daemon start, reconcile what this device launched: locally (pids from the registry) and
onto peers (ask each peer's daemon). That is the reboot case — and the daemon is the only
component that survives a reboot to run it.

## Public Interface

```bash
agents sessions --active     # gains: orphaned rows for RUNNING agents, and remote ones
agents sessions              # not-progressing work is labelled clearly
```

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Current — a working agent nobody is watching reads as fine</strong>
<pre><code>$ agents sessions --active
  ● running    claude · yosemite-s0 · 12m    Reconnect r…
  ● running    grok   · yosemite-s0 · 9m     Market
  ● running    codex  · yosemite-m4 · 4m     Dispatch</code></pre>
    <p>All three show <code>running</code>. Two of them have had no client since VS Codium
    was closed. <code>classifyHostLink</code> had no window heartbeat and no local tmux
    client count for a remote pane, so it returned <code>connected</code> — and even had it
    said <code>no-client</code>, <code>orphaned</code> only applies to an idle session.</p>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed — the owning device answers, and running can be orphaned</strong>
<pre><code>$ agents sessions
  claude  yosemite-s0  2m ago   running            Reconnect r…
  grok    yosemite-s0  4m ago   detached           Market
  codex   yosemite-m4  11m ago  running            Dispatch
  claude  zion         1h ago   idle               Prix Cloud

  default order: last activity, newest first, merged across devices
  `detached` is a label, not a sort key</code></pre>
    <p>Each peer classifies its own panes and reports it. A running agent with no client is
    surfaced, not hidden — it is the expensive case, still burning tokens.</p>
  </div>
</div>

## Validation

| Check | Expected |
| --- | --- |
| Close VS Codium with a remote agent mid-task | Row flips to `orphaned` within one daemon tick, still `running` work |
| `agents sessions detach` | Stays `connected` — never a false orphan |
| Bare-terminal tmux session, close the client | `orphaned` via `tmuxClients === 0` |
| Session with no window and no tmux | `unknown`, never `connected` |
| Reboot zion, remote agent alive on a peer | Boot reconciliation surfaces it as `orphaned` |
| Peer unreachable | `unknown` for its sessions — never inferred locally |

## Risks

| Risk | Mitigation |
| --- | --- |
| Dropping the idle precondition creates false orphans | The `deliberatelyDetached` exclusion stays first; `tmuxClients` is authoritative where present; `unknown` absorbs the no-signal case rather than `orphaned` |
| Daemon becomes a single point of failure | It is already always-on and pid-claimed; commands keep reading the index directly, so a dead daemon degrades to stale, not broken |
| P4 touches three registrars | Behaviour-preserving: same rows, one constructor |
| Asking peers adds fan-out cost | Rides the existing publish-own/read-union path; no N² probe |

## Checklist

- [x] Survey who writes `sessions.db` and how it is coordinated
- [x] Establish how `orphaned` is actually computed, and its blind spots
- [ ] P2 — `unknown` instead of default-connected; running can be orphaned
- [ ] P1 — daemon owns the pid→session map lifecycle and the status transition
- [ ] P3 — peers classify and report their own sessions
- [ ] P4 — one `createSession` contract
- [ ] P5 — boot reconciliation

## Tracking

- [RUSH-3125](https://linear.app/prix/issue/RUSH-3125) — the reconnect fixes this rests on
- RUSH-3180 — daemon owns the detached/orphaned session (this plan supersedes its scope)
- RUSH-3175 · RUSH-3139 · RUSH-3181 — consumers and adjacent fixes
