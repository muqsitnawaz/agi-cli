---
kind: plan
template: plan.v1
title: How reconnection actually works, which cases it covers, and the move into the daemon
summary: >-
  The loop is proven to fire and reach the peer — a killed client produced a /continue on
  the far side 12s later. It covers exactly one trigger: ssh exiting 255. Three real cases
  fire nothing at all, and every one of them is the daemon gap.
header: AGI CLI · reconnect mechanism
footer: Phoenix Labs
project: agents-cli
context: >-
  Owner doubts the implementation is correct and wants the mechanism shown plainly, the
  case coverage stated, and the plan for moving session handling into the daemon.
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
  - 'Proven: killing the ssh client produced a /continue of that session id on the peer 12s later'
  - 'The only trigger is exitCode === 255 — every other exit path skips reconnect entirely'
  - 'Nothing fires when the agents run process itself dies: closed tab, crash, reboot'
  - 'Detection of a silent drop takes up to ~45s (ServerAliveInterval 15 x CountMax 3)'
  - 'The end-to-end path with the tmux wrap engaged has still never been run'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Purpose

You doubt the implementation. Here is the mechanism with nothing hand-waved, what I have
actually proven about it, and the honest list of what it does not cover.

### It does fire, and I have better evidence than I have been citing

In the `yosemite-m1` test I killed the local ssh client. Twelve seconds later a **new**
process existed on the peer:

```
1841903  claude --session-id 40569293-5104-4eab-b309-86551870b26e /continue 81da4f0f-…
```

Nothing else in the system starts a `/continue` of that session id. That is
`agents sessions focus 81da4f0f… --local` running **on the peer**, finding no live pane,
and falling through to resume.

So: **the trigger fired, the loop ran, it reached the far machine, and it executed the
recovery verb there.** The mechanism works. What was missing was a *pane to attach to* —
which is the separate bug (F1). I had been reporting this as "never tested end to end",
which undersold it.

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> the loop is not the
weak part. The weak part is that it hangs off <em>one</em> trigger — ssh returning 255 —
and that it lives inside the process the drop is most likely to kill.</aside>

## Proposed Changes

### The mechanism, step by step

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 940 470" role="img" aria-label="Reconnect sequence from launch to reattach">
    <defs>
      <marker id="rm" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b8b8b" />
      </marker>
    </defs>
    <text x="20" y="24" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="11">zion — agents run (foreground)</text>
    <line x1="620" y1="10" x2="620" y2="460" stroke="#3a3a3a" stroke-dasharray="4 4" />
    <text x="640" y="24" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="11">yosemite-s0</text>

    <rect x="20" y="38" width="330" height="40" rx="5" fill="#141414" stroke="#4a4a4a" />
    <text x="34" y="63" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">runInteractiveOnHost → sshStream(-tt)</text>
    <line x1="352" y1="58" x2="700" y2="58" stroke="#8b8b8b" stroke-width="1.4" marker-end="url(#rm)" />
    <rect x="700" y="38" width="210" height="40" rx="5" fill="#101a0a" stroke="#a3e635" />
    <text x="805" y="63" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">agent runs (in a pane)</text>

    <text x="34" y="100" fill="#8b8b8b" font-family="Inter, system-ui, sans-serif" font-size="11">spawnSync blocks here for the whole session</text>

    <path d="M 600 44 L 640 76 M 640 44 L 600 76" stroke="#f87171" stroke-width="2.5" />
    <text x="620" y="96" text-anchor="middle" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="10">link drops</text>

    <rect x="20" y="118" width="330" height="46" rx="5" fill="#1a1206" stroke="#f59e0b" />
    <text x="34" y="139" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">ssh exits 255 → sshStream returns 255</text>
    <text x="34" y="156" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="10">the ONLY trigger. any other code → no reconnect</text>

    <rect x="20" y="180" width="330" height="40" rx="5" fill="#141414" stroke="#4a4a4a" />
    <text x="34" y="205" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">pickReconnectTarget → session id | launch id</text>

    <rect x="20" y="236" width="330" height="176" rx="6" fill="#0a1520" stroke="#38bdf8" />
    <text x="34" y="258" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="11">reconnectInteractiveSession — loop</text>
    <text x="34" y="280" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">1 reconnectStep → retry | stop  (pure)</text>
    <text x="34" y="298" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">2 print notice + countdown</text>
    <text x="34" y="316" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">3 waitOrInterrupt(backoff) ← Ctrl-C exits 130</text>
    <text x="34" y="334" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">4a preflight  ssh … true   (is the host up?)</text>
    <text x="34" y="352" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">4b sshStream → focus --local  (blocks)</text>
    <text x="34" y="370" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">5 classify outcome, loop</text>
    <text x="34" y="396" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">window: 15 min of unproductive retrying</text>

    <line x1="352" y1="352" x2="700" y2="352" stroke="#8b8b8b" stroke-width="1.4" marker-end="url(#rm)" />
    <rect x="700" y="300" width="220" height="104" rx="6" fill="#101a0a" stroke="#a3e635" />
    <text x="810" y="322" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">agents sessions focus --local</text>
    <text x="810" y="344" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">pane alive → ATTACH (no loss)</text>
    <text x="810" y="364" text-anchor="middle" fill="#f59e0b" font-family="Inter, system-ui, sans-serif" font-size="11">pane gone → RESUME a copy</text>
    <text x="810" y="386" text-anchor="middle" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="10">← observed: pid 1841903, /continue</text>

    <rect x="20" y="428" width="900" height="32" rx="5" fill="#1a0d0d" stroke="#f87171" />
    <text x="34" y="449" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="12">Everything in the blue box dies if the `agents run` process dies — closed tab, crash, reboot. Then nothing reconnects.</text>
  </svg>
  <figcaption><b>Figure 1.</b> The loop is sound. Its two weaknesses are structural: one
  trigger, and it lives inside the process most likely to be killed.</figcaption>
</figure>

### Which cases it handles — and which it does not

| Case | Does reconnect fire? | Outcome |
| --- | --- | --- |
| Link drops, ssh exits 255 | **yes** | attach if the pane lives, else resume a copy |
| ssh killed by a signal (`status === null` → 255) | **yes** | same — this is the case I proved |
| Wi-Fi drops silently (half-open TCP) | **yes, after ~45s** | `ServerAliveInterval 15 × CountMax 3` before ssh gives up |
| Host unreachable for a while | **yes** | preflight fails, retries for 15 min, then a clear give-up notice |
| Link flaps — reconnects then drops instantly | **yes** | `MIN_HOLD_MS` stops it spinning forever |
| Remote command exits non-255 | no, by design | the agent spoke for itself; that code is surfaced |
| Remote exits 255 for its own reasons | no — remapped to 254 | distinct notice, not mistaken for a drop |
| `--raw` / `--no-tmux` | **no** — `!isRaw` guard | plain exit |
| No reconnect target resolvable | **no** | plain exit *(this was the Grok bug; fixed by F2)* |
| **You close the VS Codium tab** | **no — the loop dies with it** | agent orphaned on the peer, nothing notices |
| **VS Codium crashes** | **no** | same |
| **Your laptop reboots** | **no** | same, and the daemon is the only thing that survives to notice |

The last three are one defect, and it is not fixable inside the loop: the loop cannot
outlive its own process.

### What I still have not proven

Being explicit, because you asked whether it is even correct:

- **The attach path.** Everything I proved landed on the *resume* branch, because there was
  no pane. I have never watched it rejoin a **live** pane and preserve an in-flight turn.
  That needs the tmux wrap shipped (1.22.48) on both ends.
- **Anything through VS Codium.** Zero of my testing went through the extension.
- **The countdown, the Ctrl-C path, the 15-minute window** in a real terminal.
- **A non-Claude harness reconnecting** — F2's whole purpose, covered only by unit tests.

### The plan for moving session handling into the daemon

Sequenced so each step is useful alone and reversible.

**Step 1 — publish, don't derive.** The daemon computes what consumers currently re-derive
— starting with the session display name — and publishes it on the session row. The ext
renders it when present. Purely additive; nothing breaks if it is absent.

**Step 2 — fix the liveness signal.** `classifyHostLink` returns `unknown` instead of
defaulting to `connected` when it has no signal, and `orphaned` stops being gated on
`idle || input_required` so a *running* agent with no client can be surfaced. (RUSH-3183.)

**Step 3 — the daemon owns the orphan.** A `detached` state written by the daemon that owns
the pane, including a **boot sweep** so a post-reboot survivor is found. Re-attach stays a
human action; the daemon surfaces and offers, never reopens. (RUSH-3180.)

**Step 4 — peers answer for themselves.** A remote session's liveness is classified by the
peer that owns the pane and reported over the existing feed, instead of being guessed from
the launching box, where the signals do not exist.

**Step 5 — the daemon hosts the coordinator.** Move `watchFleetFeed` out of the extension.
This is what structurally ends the per-tab spawn loop (agi-cli#3019) rather than throttling
it. Last, because it removes a subprocess the ext currently depends on.

**Step 6 — one `createSession`.** Three registrars (hosts / cloud / fork) collapse to one
entry point so new-row invariants are enforced once.

Steps 1–2 are small and independent. Step 3 is where the reconnect story actually completes,
because it covers the three cases the in-process loop structurally cannot.

## Public Interface

```bash
agents run <agent> --interactive --device <host>   # unchanged
agents sessions                                     # gains a `detached` label. Order unchanged.
agents sessions resume <id>                         # says whether it attached or replayed
```

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Current — one trigger, and it dies with the tab</strong>
<pre><code>link drops  →  ssh 255  →  loop runs  →  focus --local  →  ✓ handled

tab closed  →  (the loop was in that process)  →  nothing
crash       →  nothing
reboot      →  nothing

observed on yosemite-m1 after killing the client:
  1841903  claude --session-id 40569293-… /continue 81da4f0f-…
  ↑ the loop DID reach the peer — but found no pane, so it replayed</code></pre>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed — the daemon covers what the loop cannot</strong>
<pre><code>$ agents sessions
  claude  yosemite-s0  2m ago   running            Reconnect r…
  grok    yosemite-s0  4m ago   detached           Market
  codex   yosemite-m4  11m ago  running            Dispatch
  claude  zion         1h ago   idle               Prix Cloud

  default order: last activity, newest first, merged across devices
  `detached` is a label, not a sort key</code></pre>
  </div>
</div>

## Validation

| Check | Expected |
| --- | --- |
| Cut the link mid-turn, new build both ends | Countdown, then **attach** — same session id, in-flight turn intact |
| Same with Grok | Identical; proves F2 outside unit tests |
| Close the tab mid-run | Daemon marks it `detached` within a tick |
| Reboot zion with a remote agent alive | Boot sweep surfaces it |
| `--raw` run, link drops | No reconnect — documented, not a surprise |
| Kill ssh with `-9` | Reconnect fires (already proven) |

## Risks

| Risk | Mitigation |
| --- | --- |
| Step 5 breaks ext startup | It goes last, only after the data it needs is provably on the stream |
| `detached` lies | Derived from a real probe of the peer's pane, never from a missing local client |
| The 45s silent-drop detection feels slow | It is `ServerAliveInterval` — tunable, but shortening it costs false positives on a busy link |
| Daemon becomes a single point of failure | Consumers keep the direct CLI path as a degraded fallback |

## Checklist

- [x] Trace the mechanism end to end from source
- [x] Establish that the loop fires and reaches the peer (pid 1841903 evidence)
- [x] Enumerate covered and uncovered cases
- [ ] Ship 1.22.48, then prove the **attach** branch with a live pane
- [ ] Step 1 — daemon publishes the display name
- [ ] Step 2 — `unknown` + running-can-be-orphaned (RUSH-3183)
- [ ] Step 3 — daemon owns `detached` + boot sweep (RUSH-3180)
- [ ] Steps 4–6 — peer-answers, coordinator move, one `createSession`

## Tracking

- [RUSH-3125](https://linear.app/prix/issue/RUSH-3125) · RUSH-3183 · RUSH-3180 · RUSH-3175 · RUSH-3139
- agi-cli#3019 — the spawn loop step 5 ends structurally
