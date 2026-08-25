---
kind: plan
template: plan.v1
title: Where reconnect belongs, and what I have not actually verified
summary: >-
  Four requirements from the owner, each answered against the code. Reconnect is at
  the right layer (CLI) but the wrong place inside it — it dies with the terminal it
  is meant to rescue. And the end-to-end test has not been run.
header: AGI CLI · AGI EXT
footer: Phoenix Labs
project: agents-cli
context: >-
  Follow-up to RUSH-3125. The owner asked: which level owns reconnect, what happens
  with tmux off, should the daemon own it, and how was any of this actually tested.
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
  - 'Reconnect runs inside the foreground `agents run` process — it dies when the tab closes'
  - 'The ext has zero reconnect handling: grep for reconnect/dropped in watchdog.vscode.ts and terminals.vscode.ts returns 0'
  - 'The daemon already runs a watchdog, but it only handles STALLED agents, not disconnected ones'
  - 'A LOCAL agent with tmux off is still not durable — the fix only covered remote dispatch'
  - 'The full reconnect loop has never been run end to end against the new code'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Purpose

You asked four things. This answers each against the code rather than against my
memory of it, and is explicit about which parts I have and have not proven.

> **R1.** How have you tested if the reconnect fix actually works? You should spin up
> VS Code on zion, install the new CLI/extension, and actually test it.
>
> **R2.** Is the reconnect happening at the AGI CLI level or the AGI EXT level? At
> which level *should* it be implemented?
>
> **R3.** What if the user has tmux configured to be off — then what happens?
>
> **R4.** I run everything inside AGI EXT, but the right place is probably the AGI
> CLI itself — and restart is usually managed by the daemon, since the daemon is the
> single source of truth per device. Right?

Short version: **you are right on R4, and R1 is a real hole in what I delivered.**

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> reconnect is at
the correct <em>layer</em> (the CLI, not the extension) but in the wrong <em>place</em>
inside it. It lives in the foreground <code>agents run</code> process, so it dies with
the terminal it exists to rescue. The daemon — which already owns per-device liveness —
is where the durable half belongs.</aside>

## R2 — which level owns reconnect today

**Today: the CLI, entirely.** The loop is `apps/cli/src/lib/hosts/reconnect.ts`,
entered from `apps/cli/src/commands/exec.ts` after `runInteractiveOnHost` returns 255.

**The extension does nothing.** Verified, not assumed:

```
$ grep -c "reconnect\|dropped" apps/ext/src/vscode/watchdog.vscode.ts
0
$ grep -c "reconnect\|dropped" apps/ext/src/vscode/terminals.vscode.ts
0
```

**And the CLI is the right layer.** This is not my preference, it is the repo's own
stated architecture:

> **One engine, many consumers.** `apps/cli` owns the state … `apps/ext` is a
> **consumer** … It holds presentation state, not duplicate session/device/team/
> ticket/watchdog mechanisms.
>
> **One scheduler, one executor.** UI surfaces … MUST NOT own a timer, watcher, or
> loop that detects a condition and acts on it.
> — root `AGENTS.md`

The canonical incident is the 2026-08-03 ext watchdog rotate loop racing the daemon
and spawning resume-tabs every 120s into exhausted accounts. So: reconnect in the ext
would be a regression, not an improvement. **Keep it in the CLI.**

## R4 — but the daemon is where it belongs *within* the CLI

You are right, and this is the gap I did not see.

The reconnect loop runs **inside the foreground `agents run` process on zion.**
That process is the one attached to your VS Code tab. So:

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 920 300" role="img" aria-label="Reconnect dies with the terminal it is meant to rescue">
    <defs>
      <marker id="a1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b8b8b" />
      </marker>
    </defs>

    <text x="20" y="24" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="12">zion — your laptop</text>
    <line x1="600" y1="10" x2="600" y2="290" stroke="#3a3a3a" stroke-dasharray="4 4" />
    <text x="620" y="24" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="12">peer</text>

    <rect x="20" y="44" width="250" height="54" rx="6" fill="#141414" stroke="#4a4a4a" />
    <text x="145" y="66" text-anchor="middle" fill="#d4d4d4" font-family="Inter, system-ui, sans-serif" font-size="13">VS Codium tab</text>
    <text x="145" y="84" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">AGI EXT spawns the terminal</text>

    <line x1="145" y1="100" x2="145" y2="126" stroke="#8b8b8b" stroke-width="1.5" marker-end="url(#a1)" />

    <rect x="20" y="128" width="250" height="74" rx="6" fill="#1a1206" stroke="#f59e0b" stroke-width="1.5" />
    <text x="145" y="150" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">agents run (foreground)</text>
    <text x="145" y="169" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">the reconnect loop lives HERE</text>
    <text x="145" y="187" text-anchor="middle" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="11">close the tab → the loop is gone</text>

    <rect x="20" y="228" width="250" height="54" rx="6" fill="#101a0a" stroke="#a3e635" stroke-width="1.5" />
    <text x="145" y="250" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">agents daemon</text>
    <text x="145" y="268" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">survives — owns watchdog, ticks</text>

    <line x1="275" y1="165" x2="600" y2="165" stroke="#8b8b8b" stroke-width="1.5" marker-end="url(#a1)" />
    <text x="435" y="156" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">ssh -tt</text>

    <rect x="640" y="128" width="250" height="74" rx="6" fill="#101a0a" stroke="#a3e635" stroke-width="1.5" />
    <text x="765" y="150" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">tmux pane (after RUSH-3125)</text>
    <text x="765" y="169" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">agent keeps working</text>
    <text x="765" y="187" text-anchor="middle" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="11">…but nobody is coming back for it</text>
  </svg>
  <figcaption><b>Figure 1.</b> After RUSH-3125 the agent survives on the peer. But the
  thing responsible for returning you to it lives in the tab you just lost.</figcaption>
</figure>

**What the daemon already owns**, from `apps/cli/src/lib/daemon/daemon.ts`:

- the **watchdog** — "nudges this host's own stalled sessions" (daemon.ts:128)
- session-index warm ticks, fleet-cache warm, usage refresh (`daemon-ticks.js`)
- reaping tmux sessions whose panes are all dead, every 5 min (RUSH-2501)
- reaping abandoned browser tabs, every 5 min (RUSH-2622)
- the routines scheduler, pid-claimed so it can never double-fire

So the daemon is already the per-device liveness owner. **The gap is what it covers.**
`watchdog.ts` classifies a session by *timestamp idleness* and asks an agent to craft a
nudge — it handles **stalled** (agent alive, not progressing). Nothing anywhere handles:

| State | Who owns it today |
| --- | --- |
| Agent alive, making progress | nobody needs to |
| Agent alive, **stalled** | daemon watchdog ✓ |
| Agent alive, **no client attached** (link dropped) | the foreground process — which may itself be gone ✗ |
| Agent alive, **its tab was closed** | nobody ✗ |
| Agent dead, session unfinished | nobody ✗ |

That middle block is exactly your situation, and it is why the right answer is the
daemon.

## R3 — what happens when tmux is off

Four distinct cases, and only the first is fixed.

| Case | Before RUSH-3125 | After | Verdict |
| --- | --- | --- | --- |
| **Remote** run, `tmux.enabled` off | agent dies on any blink | wrapped anyway via `remoteDispatch` — survives | **fixed** |
| Remote run, `--raw` / `--no-tmux` / `AGENTS_NO_TMUX=1` | dies | **still dies** — opt-outs beat the durability rule | open decision |
| Remote run, peer has **no tmux binary** | silently fragile | **run is refused** (`undurable`) | fixed, but new failure mode |
| **Local** run (ext on zion), `tmux.enabled` off | not durable | **still not durable** | **gap — untouched** |

The last row matters because you run everything through AGI EXT, and a local launch is
an ordinary thing for it to do. With tmux off there is no pane, so a local agent has no
addressable handle and dies with its terminal — VS Code quitting or crashing takes the
agent with it. RUSH-3125 keyed the fix on `remoteDispatch`, so it deliberately did not
touch this. Whether it *should* is a real design question: a local agent has no network
to lose, but it does have a terminal to lose.

The second row is the one I flagged and would still like your read on: `--raw` currently
wins over durability, so an agent launched with it stays fragile even on a remote box. I
chose that because an escape hatch that silently stops working is worse than one that
lets you shoot yourself — but you use those flags more than I do.

## R1 — what I actually tested, and what I did not

This is the honest part. **I never ran the reconnect loop end to end against the new
code.** I proved the pieces and inferred the whole, which is exactly the thing you
caught me doing on the root cause.

**Proven, with output:**

| Claim | Evidence |
| --- | --- |
| The old code kills a remote agent | On `yosemite-m1` (no tmux): pids 1840037 + 1840092 alive, killed the local ssh client, both `GONE` 12s later |
| The new gate wraps with `tmux.enabled` off | Instrumented A/B through a real pty: no marker → `{"kind":"bare"}`, marker → `{"kind":"wrap"}` |
| A wrapped agent outlives its client | Pane `dead=0`, claude pid 46354 still alive 1:55 after its client was killed |
| Terminal restore repairs a raw tty | Real pty: echo-disabled `1` after raw, `0` after restore |
| `--launch-id` resolves without the network | Live against a real hook record → `0ef5e1b0`; unknown id fails loud, exit 1 |
| Unit + CI | 13050 pass locally; CI green on the PR (test 1m46s) |

**NOT proven:**

- **The reconnect loop itself, against the new code.** Drop a link on a wrapped remote
  agent and watch it re-attach a *live pane* rather than resume a copy. Never run.
- **Anything in VS Code / AGI EXT.** Zero of my testing went through the extension.
- **The countdown, the Ctrl-C path, the 15-minute window** in a real terminal.
- **A non-Claude harness reconnecting** — F2's whole point, tested only by unit test.

And it **cannot** be tested yet: the fix is merged but unpublished, so zion and the
peers all still run 1.22.47. Verified again just now:

```
npm latest                             1.22.47
resolveTmuxWrap in installed dist      0 occurrences
```

Both ends need the new build — the peer decides the wrap, zion runs the loop.

## Proposed Changes

Ordered. The first is verification of what already exists; the rest is the daemon move.

### P1 — actually test it, the way you described

Once 1.22.48 is published: install it on zion **and** on one peer, open a real VS Codium
tab through AGI EXT, launch a remote agent, then cut the link for real (not a `kill` —
drop the tailscale route, so `ServerAliveInterval` is what notices) and watch:

- the countdown renders and counts down
- it re-attaches a **live pane** (same session id, mid-turn state intact) — not a
  `/continue` copy
- Ctrl-C exits cleanly and prints where the agent is
- a Grok or Codex tab does the same, proving F2

Screen-record it and attach to RUSH-3125. Until that exists, RUSH-3125 is not verified,
whatever the unit tests say.

### P2 — move the durable half of reconnect into the daemon

The foreground loop stays for the case where the tab is alive — it is the right UX,
it renders the countdown, and Ctrl-C means something there. What moves to the daemon is
**ownership of the orphan**: a session whose agent is alive on a peer and whose client
is gone.

Sketch, deliberately not written as code yet because it needs the design decided first:

- The daemon already reaps dead tmux panes on a 5-minute tick. Give it the inverse:
  notice a session that is *alive on a peer* with *no attached client*, and record it as
  a distinct state (`detached`, separate from `idle` and `stalled`).
- That state is what the Fleet panel renders (RUSH-3175), and what `agents sessions`
  labelled clearly. Ordering is not part of this change.
- Re-attach stays **user-initiated**. The daemon should not silently reopen tabs; that
  is the 2026-08-03 double-fire incident in a new costume. It surfaces the state and
  offers the verb.

### P3 — decide the two open cases from R3

- Should `--raw` / `--no-tmux` be able to produce a fragile *remote* agent?
- Should a **local** agent be durable too — i.e. does the ext's local launch deserve a
  pane regardless of `tmux.enabled`?

Both are one-line changes once decided. Both are yours to call, because they trade an
escape hatch and a comfort setting against durability.

## Public Interface

No new commands. The behaviour differences a user would notice:

```bash
agents run <agent> --interactive --device <host>
#   after 1.22.48: survives a blink, reconnects for every harness
#   still fragile if launched with --raw / --no-tmux        (open, P3)
#   still fragile if run LOCALLY with tmux.enabled off      (gap, P3)

agents sessions            # after P2: a detached session carries a `detached` label
```

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Current — close the tab, lose the agent</strong>
    <pre><code>$ # link drops, or you close the VS Codium tab
$ # the reconnect loop lived in that process, so it went with it
$ agents sessions
  … the session is not surfaced as needing you.
  The agent is alive on the peer. Nothing is coming back for it.</code></pre>
    <p>Verified: pids 1840037 / 1840092 on <code>yosemite-m1</code> were <code>GONE</code>
    12s after their client died (pre-fix). Post-fix the agent lives — but the loop that
    would return you to it dies with the tab.</p>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed — the daemon owns the orphan (P2)</strong>
    <pre><code>$ agents sessions
  claude  yosemite-s0  2m ago   running            Reconnect r…
  grok    yosemite-s0  4m ago   detached           Market
  codex   yosemite-m4  11m ago  running            Dispatch
  claude  zion         1h ago   idle               Prix Cloud

  default order: last activity, newest first, merged across devices
  `detached` is a label, not a sort key</code></pre>
    <p>The daemon notices a session alive on a peer with no attached client and records
    it as <code>detached</code>. Re-attach stays user-initiated — the daemon surfaces
    the state and offers the verb, it never reopens a tab on its own.</p>
  </div>
</div>

## Validation

| Check | Expected |
| --- | --- |
| Real link drop in a VS Codium tab, new build both ends | Countdown renders; re-attach joins a live pane, same session id |
| Same, with Grok | Identical — proves F2 outside unit tests |
| Close the VS Codium tab mid-run, then look at Fleet | Session shows as `detached`, not gone (needs P2) |
| `agents sessions` after a tab close | The orphaned session is labelled, not reordered |
| Local agent, `tmux.enabled` off, quit VS Codium | Currently: agent dies. After P3 (if chosen): survives |

## Risks

| Risk | Mitigation |
| --- | --- |
| P2 becomes a second scheduler | The daemon *detects and surfaces*; re-attach stays user-initiated. Detection in the CLI, action on a human click — the `/inject` precedent. |
| A `detached` state that lies | It must be derived from a real probe of the peer's pane, not inferred from a missing local client. |
| Testing P1 needs two machines upgraded | Do it on zion + one peer only; no need to move the fleet before it is proven. |

## Checklist

- [x] Survey which level owns reconnect today (CLI; ext has zero handling)
- [x] Survey what the daemon already owns (watchdog = stalled only)
- [x] Enumerate the tmux-off cases and which are actually fixed
- [x] State honestly what was and was not verified
- [ ] P1 — publish 1.22.48, install on zion + one peer, real drop test in VS Codium, recorded
- [ ] P3 — decide `--raw` and local-durability
- [ ] P2 — daemon owns the detached-session state

## Tracking

- [RUSH-3125](https://linear.app/prix/issue/RUSH-3125) — the merged fixes, awaiting release + P1 verification
- [RUSH-3175](https://linear.app/prix/issue/RUSH-3175) — ext renders the state (consumes P2)
- [RUSH-3139](https://linear.app/prix/issue/RUSH-3139) — dead pane silently resumes a copy
