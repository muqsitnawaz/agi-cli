---
kind: report
template: report.v1
title: Every way a session comes back, and which interruptions each one survives
summary: >-
  Surveyed from the code, not the docs. There are two fundamentally different
  mechanisms — attach a live process, or replay a transcript into a new one — and
  most of the confusion is that one verb does both without saying which it did.
header: AGI CLI · session recovery
footer: Phoenix Labs
project: agents-cli
context: >-
  Owner asked what interruptions reconnect is meant to handle, whether it survives a
  machine reboot, how the resume-into-a-program mechanism relates, and whether tmux
  can be adopted without breaking users who do or do not already use it.
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
  - 'Two mechanisms: ATTACH rejoins a live process; RESUME replays a transcript into a new one'
  - 'Resume does NOT require tmux — tmux is one of five terminal backends'
  - 'Our tmux runs on its own socket and sources the user config after our defaults, so user bindings win'
  - 'No launchd unit keeps the tmux server alive, so a reboot makes attach impossible — replay only'
  - 'A LOCAL crash does not kill a REMOTE agent: it stays attachable, and nothing tells you'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Summary

Surveyed from the source. There are **two** recovery mechanisms, not many: **attach** a
live process, or **replay** a transcript into a new one. `resume` silently does either and
never says which — that is the root of the "it barely works" feeling. Resume does not need
tmux (tmux is one of five terminal backends). A machine reboot kills a *local* agent for
good, but leaves a *remote* one alive and attachable — and nothing tells you. Existing tmux
users are already protected by design; users who don't know tmux see a status bar they
didn't ask for.

## Findings

### The distinction everything else hangs off

Read from the code, the recovery surface is not many mechanisms. It is **two**, and
almost every confusion comes from one verb doing both without telling you which:

**ATTACH** — rejoin the *process that is still running*. Needs a live handle: a tmux
pane, or a Ghostty tab. **Nothing is lost**; you are back in the same agent, mid-turn.

**RESUME** — start a *new* process that replays the transcript. Needs no live handle,
only the transcript on disk. **The in-flight turn is gone**; the agent re-reads the
conversation and continues from there.

`lib/session/recovery.ts:18` shows resume has exactly two shapes, and neither of them
attaches to anything:

```ts
export type SessionRecoveryTarget =
  | { mode: 'native';   agent: AgentId; version: string; cwd?: string; reason: string }
  | { mode: 'continue'; agent: AgentId; version: string; reason: string };
```

`native` = the harness's own `--resume`. `continue` = a `/continue` replay. Both are a
**new process**.

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> when you said the
agent "comes back as a stranger", that was resume, not attach. The system silently
degrades from one to the other and never says so — which is RUSH-3139, and is the single
biggest source of the "it barely works" feeling.</aside>

### The verbs that actually exist

From `agents sessions --help` and the command sources, not the docs:

| Verb | What it really does | Needs a live process? |
| --- | --- | --- |
| `sessions resume <id>` | **The one front door.** Attaches a live pane if there is one, else recovers. `--attach-only` refuses to fall through | no |
| `sessions focus` | Older spelling, hidden. Same body — `focusAction` | no |
| `sessions attach` | Deprecated → `resume`. Was: stop the headless continuation, bring it back interactive | no |
| `sessions detach <id>` | Park a live agent to headless — keeps working, no terminal | yes |
| `sessions stop <id>` | End it and tear down its tmux/mux session | yes |
| `sessions inject <id> <text>` | Type into the terminal a live session lives in — how the daemon watchdog nudges | yes |
| `sessions migrate <id>` | Move a running session to another machine | yes |
| *(reconnect loop)* | Not a verb. Runs inside `agents run`, calls focus on a dropped link | — |

### "Select which program to resume into" — and no, it does not need tmux

That is the **terminal launch engine**, `lib/terminal/backends/`:

```
ghostty.ts   iterm.ts   terminal-app.ts   tmux.ts   vscodium-agent.ts
```

**tmux is one backend of five.** When you multi-select in `sessions resume`, it fans each
pick into a tab/split via whichever backend fits — VS Codium, Ghostty, iTerm, Terminal.app.
That path is a *resume* (new process, transcript replay), so it works with tmux entirely
absent. That is why it felt like a separate, weirder mechanism: it is a different
mechanism, and it is the one that always works.

### What survives which interruption

The table you actually asked for. `agent` = the harness process; `pane` = the tmux pane
holding it.

| Interruption | Agent | Pane | Attach possible? | What you get today |
| --- | --- | --- | --- | --- |
| Network blink, remote agent, **wrapped** (post-RUSH-3125) | lives | lives | **yes** | reconnect loop re-attaches — no loss |
| Network blink, remote agent, tmux off (today's shipped code) | **dies** | — | no | replay, or nothing |
| Network blink, `--raw` / `--no-tmux` | **dies** | — | no | replay, or nothing |
| **Close the VS Codium tab** | lives | lives | **yes** | *nothing happens* — the reconnect loop died with the tab |
| **VS Codium crashes** | lives | lives | **yes** | same — orphaned, nothing surfaces it |
| **Your laptop reboots**, agent is on a **peer** | **lives** | **lives** | **yes** | *nothing happens* — this is recoverable and nobody tells you |
| **Your laptop reboots**, agent is **local** | dies | dies | **no** | replay only |
| Peer reboots | dies | dies | no | replay only |
| Agent exits on its own | dies | pane kept (`remain-on-exit`) | no | replay |

Two rows matter most, and both are the same defect:

**Your reboot question, precisely:** if the agent was **local**, no — the tmux server has
no launchd unit (`~/Library/LaunchAgents/` holds `agents-daemon`, `agents-menubar`,
`computer-helper`, `whatsapp-bridge` — no tmux), so the server dies with the machine and
attach is impossible. Replay is all there is.

But if the agent was on a **peer** — which is how you actually work — your laptop
rebooting does not touch it. The peer's tmux keeps running and the agent is still there,
still attachable, **fully recoverable with zero loss**. Today nothing tells you that, and
nothing goes and gets it. That is the daemon gap.

### tmux, for users who do and do not already use it

You were right to worry about both, and the code already answers one of them well.

**Existing tmux users: safe, by design.** Two mechanisms:

1. **Separate server.** We run on our own socket (`~/.agents/.cache/helpers/tmux/server.sock`,
   `lib/tmux/paths.ts:18`), so your own tmux server, sessions and windows are untouched.
2. **Your config still wins.** `writeStartupConfig` (`lib/tmux/session.ts:54`) writes our
   defaults *first*, then `source-file -q` every config tmux itself would have loaded —
   and it deliberately sources **all** of them, not just the first:

   > tmux's own `start_cfg()` sources EVERY entry of `TMUX_CONF` that exists, not just the
   > first … Sourcing only the first would silently drop the second and break the "never
   > override a user-set value" contract this file exists to keep.

   Config files execute in order, so ours are defaults and every option or binding you set
   overrides them.

**Users who don't know tmux: the gap you predicted is real.** The defaults are chosen for
them — `mouse on`, `set-clipboard on`, 100k history, copy-mode drag-to-copy
(`session.ts:79-84`) — so scrolling and selecting behave normally. But there is **no
`status off`**, so they get a tmux status bar at the bottom of their agent tab and a
prefix key they have never heard of. For someone who did not opt into tmux, that is a
visible, confusing artifact of an implementation detail.

**Leaked processes: already solved, better than I expected.** `lib/tmux/orphan-reap.ts`
(RUSH-2521) reaps helpers an exited agent leaves behind, attributing them **by environment**
rather than pid ancestry — because every obvious handle is destroyed by the very event
being detected:

> **ppid ancestry** — an orphan is reparented to init the instant its parent dies …
> **controlling terminal** — POSIX disassociates it … **process group** — the helpers that
> survive are precisely the ones that left the pane's group.

Measured motivation in that file: one pane holding **2.5 GB** of Claude Code background
daemons 22 days after its session ended, and 34 orphaned `cgraph-mcp --daemon` processes on
a single worker. The daemon sweeps this every 5 minutes.

## Evidence

### What is actually broken

Not the mechanisms. Each works. Three things are missing between them:

1. **Nobody owns an orphaned-but-alive session.** Close the tab, crash VS Codium, reboot
   your laptop — the remote agent is fine and attachable, and nothing notices or offers it.
   The reconnect loop can't: it lived in the tab.
2. **Resume masquerades as attach.** When the pane is gone, `focus` silently falls through
   to replay. Same verb, completely different outcome, no notice. (RUSH-3139.)
3. **Non-tmux users see tmux.** The wrap is an implementation detail leaking into the UI as
   a status bar and unfamiliar keys.

## Recommendation

**Own the orphan in the daemon, and never let resume pretend to be attach.**

- The daemon already sweeps tmux panes every 5 minutes and already runs the watchdog. Give
  it one more state: a session **alive on a peer with no client attached**. On boot it
  should find these — that is exactly the post-reboot case, and it is the one where attach
  still works and today does nothing.
- Surface that state first in `agents sessions` and the Fleet panel; re-attach stays a
  user action, never an automatic tab-reopen.
- Make the attach-vs-replay outcome explicit at every call site: say *"rejoined the live
  agent"* or *"the pane was gone — replayed the transcript, the in-flight turn is lost."*
- For non-tmux users, hide the chrome: `status off` on our server by default, restorable
  for people who want it. The durability is the point; the status bar is not.

None of that requires making users learn tmux, and none of it changes their config.
