---
kind: plan
surface: cli
title: "agents sessions viz — see a session's trajectory, and compare across sessions"
summary: >
  Today the only way to inspect a transcript is `agents sessions render`, a
  linear redacted-Markdown wall with no timing, no shape, no way to compare two
  runs. This adds `agents sessions viz` — a self-contained HTML trajectory view
  (a tool-call waterfall over a real time axis, color-coded, with derived
  analysis) for one session, and a compare/lineage view across several. It is
  the successor to the removed Rush "Sessions Inspector" (rush dev), rebuilt on
  the CLI's own normalized SessionEvent model so it works for every harness.
status: awaiting-go
facts:
  - "Every harness normalizes to one SessionEvent union (types.ts:46) via parseSession (parse.ts:194)"
  - "No per-step duration exists anywhere — computed by pairing tool_use↔tool_result on callId"
  - "share-html.ts is the precedent: self-contained page, inline CSS, no CDN, redaction-safe"
  - "sessions render emits Markdown only; -o out.html is explicitly rejected (sessions-render.ts:120)"
  - "The prior 'good UI' was Rush's Sessions Inspector, removed in b799a5ce0 (2026-04-23)"
links:
  - url: https://github.com/phnx-labs/agi-cli/pull/2909
    label: "In-flight: PR #2909 session tab title sync (adjacent surface)"
---

## Focus for review

- **The visual is the pick.** Look at the mock-ups below and judge the single-session trajectory view and the compare view against what you remember of the Rush inspector. Everything downstream serves that picture.
- **Two audiences, one model (the load-bearing principle).** The same `buildTrajectory()` model renders three ways — **HTML** for a human, a compact **text** trajectory for an agent reading in-context, and **`--json`** for programmatic callers — and the CLI picks the right one by whether stdout is a TTY. A human at a terminal gets the visual; a headless agent asking "where did session X stall?" gets a 10-line answer, no flags. This is the elevation from "a nice UI" to a core primitive.
- **Surface shape (your call).** Canonical is a verb under the noun that owns it: `agents sessions <verb>`. Because it's core, add a top-level alias — precedent: `agents insights` aliases `agents sessions insights`. So `agents trace <id>` (top-level, memorable) → `agents sessions trace <id>` (canonical). One implementation, one owned home, a first-class door. A *new* top-level group would split the session surface and trip the "duplicate surface" review rule — not recommended.
- **Command name.** `trace` (recommended now — reads well both as `agents trace` and `sessions trace`, and it's the observability word) vs `viz` vs `timeline`. `inspect` is out — collides with `agents inspect <agent>`.
- **Scope of v1.** Single trajectory + compare + lineage, each in all three renderings. Is the lineage graph in v1, or a fast-follow? No server/daemon — one-shot render; live is already `sessions tail`/`watch`.

## Intent

> "spec out a command in the agent CLI that will let me visualize a session, and multiple sessions — analyze the trajectories. Previously the rush CLI had debugging functionality — a visual timeline where you can see which tool calls and all those things. It was a very good UI. I want similar functionality."

Restated: give the CLI a real debugger for agent runs — see the *shape* of one session (what tools fired, in what order, how long each took, where it errored, where it stalled), and lay several sessions side by side to see where they diverge. Match the feel of the old Rush "Sessions Inspector," rebuilt on agents-cli's own data.

<div class="artifact-callout">
<p><strong>Proposal:</strong> add <code>agents sessions trace &lt;selectors…&gt;</code> (canonical) with a top-level alias <code>agents trace</code> (precedent: <code>agents insights</code>). One pure <code>buildTrajectory()</code> model, rendered three ways and auto-selected by audience: <strong>HTML</strong> on your interactive host for a human, a compact <strong>text</strong> trajectory for an agent, <strong>JSON</strong> for programs. One session → a <em>trajectory</em> (tool-call waterfall + analysis); several → a <em>compare</em> (aligned lanes + step diff); a parent + its team → a <em>lineage</em> graph. Renderer follows <code>share-html.ts</code>: self-contained, no CDN, redacted by default.</p>
</div>

## What you'll see

The difference between reading a transcript and *seeing* a run. Current: a linear Markdown wall you scroll. Proposed: the run's shape, at a glance.

<div class="artifact-behavior">
  <div class="artifact-panel" data-state="current" data-evidence="mockup">
    <h4>Current — <code>agents sessions render 71bb3b3b -o s.md</code> (Markdown wall)</h4>
    <svg viewBox="0 0 470 280" role="img" aria-label="A linear Markdown transcript: user turn, assistant text, tool calls one after another as text, no timing or shape" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="470" height="280" fill="#0d1117"/>
      <rect x="0" y="0" width="470" height="22" fill="#161b22"/>
      <circle cx="14" cy="11" r="4" fill="#ff5f56"/><circle cx="28" cy="11" r="4" fill="#ffbd2e"/><circle cx="42" cy="11" r="4" fill="#27c93f"/>
      <text x="130" y="15" fill="#8b98a5" font-family="Inter, system-ui, sans-serif" font-size="11">s.md — 2,140 lines</text>
      <text x="12" y="44" fill="#7ee787" font-family="JetBrains Mono, monospace" font-size="10.5">## user</text>
      <text x="12" y="60" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="10.5">rebase my open PR and get CI green</text>
      <text x="12" y="84" fill="#7ee787" font-family="JetBrains Mono, monospace" font-size="10.5">## assistant</text>
      <text x="12" y="100" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="10.5">I'll fetch origin and check how far behind…</text>
      <text x="12" y="120" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="10.5">**Bash** `git fetch origin` → ok</text>
      <text x="12" y="136" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="10.5">**Read** apps/cli/src/lib/exec.ts</text>
      <text x="12" y="152" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="10.5">**Bash** `bun test exec.test.ts` → …</text>
      <text x="12" y="168" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="10.5">**Edit** apps/cli/src/lib/exec.ts</text>
      <text x="12" y="184" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="10.5">**Bash** `bun test exec.test.ts` → …</text>
      <text x="12" y="200" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="10.5">… 2,000 more lines …</text>
      <rect x="12" y="222" width="446" height="46" rx="6" fill="#161109" stroke="#7a5c1e" stroke-width="1"/>
      <text x="22" y="240" fill="#e0b341" font-family="Inter, system-ui, sans-serif" font-size="10.5">No timing. No shape. Which step took 8 min?</text>
      <text x="22" y="258" fill="#e0b341" font-family="Inter, system-ui, sans-serif" font-size="10.5">Where did it stall? You cannot tell — you read it all.</text>
    </svg>
  </div>
  <div class="artifact-panel" data-state="proposed" data-evidence="mockup">
    <h4>Proposed — <code>agents sessions viz 71bb3b3b</code> (trajectory, opens on zion)</h4>
    <svg viewBox="0 0 470 280" role="img" aria-label="A trajectory waterfall: tool calls as horizontal bars over a time axis, color-coded by tool, one long red error bar, an idle gap, a metrics header" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="470" height="280" fill="#0a0a0a"/>
      <rect x="0" y="0" width="470" height="30" fill="#0f160a"/>
      <text x="12" y="19" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">● 71bb3b3b claude·opus-4.8 · AGI</text>
      <text x="300" y="19" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="10">14m · 47 tools · 2✗ · $1.20</text>
      <line x1="70" y1="44" x2="452" y2="44" stroke="#2a2a2a" stroke-width="1"/>
      <text x="70" y="40" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">0m</text>
      <text x="250" y="40" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">7m</text>
      <text x="436" y="40" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">14m</text>
      <text x="10" y="63" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="9">Bash</text>
      <rect x="70" y="55" width="26" height="10" rx="2" fill="#e0b341"/>
      <text x="10" y="81" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="9">Read</text>
      <rect x="100" y="73" width="40" height="10" rx="2" fill="#4a9eff"/>
      <text x="10" y="99" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="9">Bash</text>
      <rect x="145" y="91" width="150" height="10" rx="2" fill="#f87171"/>
      <text x="300" y="99" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="8">bun test → 2 fail (8m)</text>
      <text x="10" y="117" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="9">Edit</text>
      <rect x="300" y="109" width="22" height="10" rx="2" fill="#7ee787"/>
      <text x="10" y="135" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="9">Task</text>
      <rect x="326" y="127" width="70" height="10" rx="2" fill="#b98cff"/>
      <text x="332" y="135" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="8">subagent</text>
      <rect x="200" y="150" width="60" height="14" rx="2" fill="#160b0b" stroke="#7a3030" stroke-width="0.8" stroke-dasharray="3 2"/>
      <text x="206" y="160" fill="#c06a6a" font-family="Inter, system-ui, sans-serif" font-size="8.5">idle 3m — stall</text>
      <rect x="10" y="178" width="450" height="1" fill="#222"/>
      <text x="12" y="196" fill="#8b98a5" font-family="Inter, system-ui, sans-serif" font-size="9.5">Where the time went</text>
      <rect x="12" y="204" width="180" height="8" rx="2" fill="#f87171"/><text x="198" y="211" fill="#7c8894" font-family="JetBrains Mono, monospace" font-size="8">Bash 61%</text>
      <rect x="12" y="216" width="70" height="8" rx="2" fill="#b98cff"/><text x="88" y="223" fill="#7c8894" font-family="JetBrains Mono, monospace" font-size="8">Task 22%</text>
      <rect x="12" y="228" width="34" height="8" rx="2" fill="#4a9eff"/><text x="52" y="235" fill="#7c8894" font-family="JetBrains Mono, monospace" font-size="8">Read 9%</text>
      <rect x="250" y="196" width="210" height="70" rx="6" fill="#0f160a" stroke="#2a3a1a" stroke-width="1"/>
      <text x="260" y="212" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">▸ step 12 · Bash (8m04s) ✗</text>
      <text x="260" y="228" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="8.5">bun test src/lib/exec.test.ts</text>
      <text x="260" y="242" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="8.5">exit 1 · 2 failing · retried ×3</text>
      <text x="260" y="257" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="8.5">click any bar → full args + output</text>
    </svg>
  </div>
</div>

The hero, full width — the trajectory waterfall for one session. Time on the x-axis, one row per tool call, bars colored by tool, errors in red, stalls called out, an assistant-thinking track above the tools, and a synced step-detail rail on the right (click a bar → it scrolls and expands). This is the picture the old inspector gave you, on your own data.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 920 400" role="img" aria-label="Full trajectory view: header metrics, a time axis, thinking track, tool-call waterfall with colored duration bars and an error, an idle-gap marker, and a step-detail panel" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="920" height="400" fill="#0a0a0a"/>
  <rect x="0" y="0" width="920" height="40" fill="#0f160a"/>
  <text x="20" y="25" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="14">agents sessions viz 71bb3b3b</text>
  <text x="330" y="25" fill="#d7e0e6" font-family="JetBrains Mono, monospace" font-size="11">claude · opus-4.8 · AGI · ~/src/agents-cli · edit</text>
  <text x="720" y="18" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="10">14m 22s · 47 tool calls</text>
  <text x="720" y="32" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="10">2 errors · 312K out · $1.20 · 6 files</text>
  <text x="150" y="60" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="10" font-weight="bold">TRAJECTORY</text>
  <line x1="150" y1="72" x2="660" y2="72" stroke="#2a2a2a" stroke-width="1"/>
  <text x="150" y="68" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">0m</text>
  <text x="320" y="68" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">5m</text>
  <text x="490" y="68" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">10m</text>
  <text x="645" y="68" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">14m</text>
  <text x="20" y="90" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="9">think</text>
  <rect x="150" y="83" width="18" height="6" rx="2" fill="#3a3a55"/>
  <rect x="230" y="83" width="12" height="6" rx="2" fill="#3a3a55"/>
  <rect x="470" y="83" width="24" height="6" rx="2" fill="#3a3a55"/>
  <g font-family="JetBrains Mono, monospace" font-size="9">
    <text x="20" y="108" fill="#8b98a5">Bash</text><rect x="150" y="100" width="20" height="11" rx="2" fill="#e0b341"/><text x="176" y="109" fill="#7c8894" font-size="8">git fetch (2s)</text>
    <text x="20" y="126" fill="#8b98a5">Grep</text><rect x="172" y="118" width="16" height="11" rx="2" fill="#4a9eff"/>
    <text x="20" y="144" fill="#8b98a5">Read</text><rect x="190" y="136" width="34" height="11" rx="2" fill="#4a9eff"/><text x="228" y="145" fill="#7c8894" font-size="8">exec.ts</text>
    <text x="20" y="162" fill="#8b98a5">Bash</text><rect x="230" y="154" width="200" height="11" rx="2" fill="#f87171"/><text x="436" y="163" fill="#f87171" font-size="8">bun test → 2 fail · exit 1 · retried ×3 (8m 04s)</text>
    <text x="20" y="180" fill="#8b98a5">Edit</text><rect x="432" y="172" width="16" height="11" rx="2" fill="#7ee787"/><text x="452" y="181" fill="#7c8894" font-size="8">exec.ts</text>
    <text x="20" y="198" fill="#8b98a5">Bash</text><rect x="450" y="190" width="46" height="11" rx="2" fill="#e0b341"/><text x="500" y="199" fill="#7c8894" font-size="8">bun test → pass (1m 40s)</text>
    <text x="20" y="216" fill="#8b98a5">Task</text><rect x="498" y="208" width="70" height="11" rx="2" fill="#b98cff"/><text x="504" y="217" fill="#0a0a0a" font-size="8">code-review ↘</text>
    <text x="20" y="234" fill="#8b98a5">Bash</text><rect x="590" y="226" width="30" height="11" rx="2" fill="#e0b341"/><text x="624" y="235" fill="#7c8894" font-size="8">git push · gh pr</text>
  </g>
  <rect x="360" y="248" width="90" height="16" rx="3" fill="#160b0b" stroke="#7a3030" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="368" y="259" fill="#c06a6a" font-family="Inter, system-ui, sans-serif" font-size="9">idle 3m 10s — stall</text>
  <text x="150" y="290" fill="#6e7681" font-family="Inter, system-ui, sans-serif" font-size="9">
    <tspan fill="#e0b341">■</tspan> Bash  <tspan fill="#4a9eff">■</tspan> Read/Grep  <tspan fill="#7ee787">■</tspan> Edit/Write  <tspan fill="#b98cff">■</tspan> Task/subagent  <tspan fill="#f87171">■</tspan> error  <tspan fill="#3a3a55">■</tspan> thinking
  </text>
  <rect x="688" y="80" width="216" height="300" rx="8" fill="#0d1117" stroke="#233" stroke-width="1"/>
  <text x="702" y="102" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">▸ STEP 12 / 47</text>
  <text x="702" y="120" fill="#d7e0e6" font-family="JetBrains Mono, monospace" font-size="10">Bash · 08:41→08:49</text>
  <text x="702" y="136" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="9">outcome: error (exit 1)</text>
  <rect x="702" y="146" width="188" height="1" fill="#233"/>
  <text x="702" y="164" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="9">command</text>
  <text x="702" y="180" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="8.5">bun test src/lib/</text>
  <text x="702" y="192" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="8.5">exec.test.ts</text>
  <text x="702" y="214" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="9">output (redacted)</text>
  <rect x="702" y="222" width="188" height="70" rx="4" fill="#0a0a0a"/>
  <text x="710" y="238" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="8">2 fail · 44 pass</text>
  <text x="710" y="252" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="8">✗ resolves fallback</text>
  <text x="710" y="266" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="8">✗ rotates account</text>
  <text x="710" y="284" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="8">retried ×3</text>
  <text x="702" y="318" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="9">tokens this step</text>
  <text x="702" y="334" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="8.5">18.4K out · 2 cache</text>
  <text x="702" y="360" fill="#6e7681" font-family="Inter, system-ui, sans-serif" font-size="8.5">← → step · f filter tool · e errors only</text>
</svg>
</div>

Two shapes of delegation show up here, and the plan draws them differently (a distinction the blind review surfaced): an **inline `Task` sub-agent** runs *inside* this transcript — it is a `tool_use` row, so it draws as a nested branch on the waterfall; a **`teams` teammate** is a *separate* session linked by `parentSessionId`, so it belongs on the lineage graph, not this timeline.

### Comparing several sessions

Pass more than one selector and the page becomes a **compare** — the same task run two ways (here Claude vs Codex on the same ticket), laid on a shared axis so you can see exactly where they diverge, plus a step-level diff and a summary table. When the selectors are a parent and its teammates instead, the page opens on the **lineage graph** (below).

<div class="artifact-figure-diagram">
<svg viewBox="0 0 920 340" role="img" aria-label="Compare view: two sessions as stacked lanes on a shared time axis, a divergence marker where their trajectories differ, and a summary table" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="920" height="340" fill="#0a0a0a"/>
  <rect x="0" y="0" width="920" height="34" fill="#0f160a"/>
  <text x="20" y="22" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="13">agents sessions viz 71bb3b3b a1c40f22 --compare</text>
  <text x="560" y="22" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="10">same ticket RUSH-3036 · two harnesses</text>
  <line x1="150" y1="56" x2="880" y2="56" stroke="#2a2a2a" stroke-width="1"/>
  <text x="150" y="52" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">0m</text>
  <text x="500" y="52" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">10m</text>
  <text x="860" y="52" fill="#5a5a5a" font-family="JetBrains Mono, monospace" font-size="8">20m</text>
  <text x="20" y="88" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">claude</text>
  <text x="20" y="102" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="8">14m · 47 · 2✗</text>
  <g>
    <rect x="150" y="78" width="30" height="12" rx="2" fill="#4a9eff"/>
    <rect x="184" y="78" width="20" height="12" rx="2" fill="#e0b341"/>
    <rect x="208" y="78" width="150" height="12" rx="2" fill="#f87171"/>
    <rect x="362" y="78" width="20" height="12" rx="2" fill="#7ee787"/>
    <rect x="386" y="78" width="60" height="12" rx="2" fill="#b98cff"/>
    <rect x="450" y="78" width="40" height="12" rx="2" fill="#e0b341"/>
  </g>
  <text x="20" y="140" fill="#4a9eff" font-family="JetBrains Mono, monospace" font-size="10">codex</text>
  <text x="20" y="154" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="8">19m · 63 · 5✗</text>
  <g>
    <rect x="150" y="130" width="30" height="12" rx="2" fill="#4a9eff"/>
    <rect x="184" y="130" width="20" height="12" rx="2" fill="#e0b341"/>
    <rect x="208" y="130" width="90" height="12" rx="2" fill="#e0b341"/>
    <rect x="300" y="130" width="120" height="12" rx="2" fill="#f87171"/>
    <rect x="424" y="130" width="120" height="12" rx="2" fill="#f87171"/>
    <rect x="548" y="130" width="40" height="12" rx="2" fill="#7ee787"/>
    <rect x="592" y="130" width="120" height="12" rx="2" fill="#e0b341"/>
  </g>
  <line x1="300" y1="70" x2="300" y2="150" stroke="#e0b341" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="306" y="172" fill="#e0b341" font-family="Inter, system-ui, sans-serif" font-size="9">◆ diverge @ ~4m: codex re-runs the failing test 3× before editing; claude edits first</text>
  <rect x="20" y="196" width="880" height="1" fill="#222"/>
  <text x="20" y="216" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="10" font-weight="bold">Summary</text>
  <g font-family="JetBrains Mono, monospace" font-size="10">
    <text x="30" y="240" fill="#6e7681">session</text><text x="220" y="240" fill="#6e7681">tools</text><text x="320" y="240" fill="#6e7681">errors</text><text x="430" y="240" fill="#6e7681">duration</text><text x="560" y="240" fill="#6e7681">tokens</text><text x="680" y="240" fill="#6e7681">outcome</text>
    <text x="30" y="262" fill="#a3e635">claude 71bb3b3b</text><text x="220" y="262" fill="#d7e0e6">47</text><text x="320" y="262" fill="#7ee787">2</text><text x="430" y="262" fill="#d7e0e6">14m 22s</text><text x="560" y="262" fill="#d7e0e6">312K</text><text x="680" y="262" fill="#7ee787">merged ✓</text>
    <text x="30" y="284" fill="#4a9eff">codex  a1c40f22</text><text x="220" y="284" fill="#d7e0e6">63</text><text x="320" y="284" fill="#f87171">5</text><text x="430" y="284" fill="#d7e0e6">19m 40s</text><text x="560" y="284" fill="#d7e0e6">507K</text><text x="680" y="284" fill="#e0b341">stalled</text>
  </g>
  <rect x="20" y="300" width="880" height="26" rx="4" fill="#0f160a"/>
  <text x="30" y="317" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="9.5">step diff: +16 extra tool calls in codex, all in the test-retry loop before its first Edit — the trajectory divergence, quantified.</text>
</svg>
</div>

### Team lineage — a parent and its teammates

When the selection is an orchestrator plus the sessions it spawned (via `parentSessionId` / `teamOrigin`), the page auto-discovers the delegation edges and draws the lineage graph — the direct descendant of the old inspector's ArchitecturePanel. Each node is one session, colored by outcome; click a node to load that session's trajectory below.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 920 300" role="img" aria-label="Lineage graph: an orchestrator session at top with edges down to three teammate sessions, each a node with tool count and status; one teammate has a nested subagent" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="920" height="300" fill="#0a0a0a"/>
  <defs><marker id="lg" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4a6b3a"/></marker></defs>
  <text x="20" y="26" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="13">agents sessions viz e0ffab12 --tree</text>
  <text x="420" y="26" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="10">team "fleet-resume" · 1 orchestrator → 3 teammates</text>
  <rect x="360" y="50" width="200" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="374" y="72" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">◆ e0ffab12 · claude</text>
  <text x="374" y="90" fill="#7c8894" font-family="JetBrains Mono, monospace" font-size="9">orchestrator · 22 tools · running</text>
  <path d="M420 102 L200 150" fill="none" stroke="#4a6b3a" stroke-width="1.4" marker-end="url(#lg)"/>
  <path d="M460 102 L460 150" fill="none" stroke="#4a6b3a" stroke-width="1.4" marker-end="url(#lg)"/>
  <path d="M500 102 L720 150" fill="none" stroke="#4a6b3a" stroke-width="1.4" marker-end="url(#lg)"/>
  <rect x="90" y="152" width="200" height="52" rx="8" fill="#0d1117" stroke="#7ee787" stroke-width="1.3"/>
  <text x="104" y="174" fill="#7ee787" font-family="JetBrains Mono, monospace" font-size="10">auth · 4f21 · codex</text>
  <text x="104" y="192" fill="#7c8894" font-family="JetBrains Mono, monospace" font-size="9">31 tools · 12m · merged ✓</text>
  <rect x="360" y="152" width="200" height="52" rx="8" fill="#0d1117" stroke="#e0b341" stroke-width="1.3"/>
  <text x="374" y="174" fill="#e0b341" font-family="JetBrains Mono, monospace" font-size="10">ui · a90c · claude</text>
  <text x="374" y="192" fill="#7c8894" font-family="JetBrains Mono, monospace" font-size="9">18 tools · 9m · idle (unfinished)</text>
  <rect x="620" y="152" width="200" height="52" rx="8" fill="#0d1117" stroke="#f87171" stroke-width="1.3"/>
  <text x="634" y="174" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="10">api · c7d2 · grok</text>
  <text x="634" y="192" fill="#7c8894" font-family="JetBrains Mono, monospace" font-size="9">44 tools · 21m · 6✗ crashed</text>
  <path d="M720 204 L720 234" fill="none" stroke="#3a4a5a" stroke-width="1.2" marker-end="url(#lg)"/>
  <rect x="640" y="236" width="160" height="40" rx="6" fill="#0a0a0a" stroke="#3a4a5a" stroke-width="1"/>
  <text x="652" y="254" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="9">↳ Explore subagent</text>
  <text x="652" y="268" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="8.5">9 tools · read-only</text>
  <text x="90" y="296" fill="#6e7681" font-family="Inter, system-ui, sans-serif" font-size="9">node color = outcome · click a node → its trajectory loads below · edges auto-discovered from parentSessionId / teamOrigin</text>
</svg>
</div>

### The same run, three ways — human, agent, machine

One `buildTrajectory()` model, three renderings, and the CLI auto-selects by audience: **TTY → open the HTML** (a person is watching); **non-TTY → print the compact text** (an agent piped it); **`--json` → the model** (a program asked). No flags needed for the common case of each. This is what makes it "usable by humans but also agents": the same command serves an operator debugging a run and a watchdog agent triaging a stalled fleet.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 920 300" role="img" aria-label="Three renderings side by side of the same session: an HTML visual for humans, a compact text trajectory for agents, and a JSON model for programs" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="920" height="300" fill="#0a0a0a"/>
  <!-- human -->
  <rect x="14" y="14" width="288" height="272" rx="8" fill="#0d1117" stroke="#2a3a44" stroke-width="1"/>
  <text x="28" y="38" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="bold">HUMAN — TTY</text>
  <text x="28" y="54" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="9">agents trace 71bb3b3b</text>
  <text x="28" y="68" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="9">→ opens HTML on your interactive host</text>
  <rect x="28" y="78" width="260" height="120" rx="4" fill="#0a0a0a" stroke="#1e2a1a" stroke-width="1"/>
  <line x1="40" y1="96" x2="276" y2="96" stroke="#222" stroke-width="1"/>
  <rect x="40" y="104" width="30" height="8" rx="2" fill="#e0b341"/>
  <rect x="74" y="116" width="60" height="8" rx="2" fill="#4a9eff"/>
  <rect x="138" y="128" width="120" height="8" rx="2" fill="#f87171"/>
  <rect x="60" y="140" width="24" height="8" rx="2" fill="#7ee787"/>
  <rect x="88" y="152" width="46" height="8" rx="2" fill="#b98cff"/>
  <text x="40" y="180" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="8.5">clickable waterfall · step rail · charts</text>
  <text x="28" y="222" fill="#8b98a5" font-family="Inter, system-ui, sans-serif" font-size="9">the "very good UI" — for the person</text>
  <text x="28" y="238" fill="#6e7681" font-family="Inter, system-ui, sans-serif" font-size="9">at the desk, deciding what to do.</text>

  <!-- agent -->
  <rect x="316" y="14" width="288" height="272" rx="8" fill="#0d1117" stroke="#3a4a2a" stroke-width="1.3"/>
  <text x="330" y="38" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="bold">AGENT — non-TTY</text>
  <text x="330" y="54" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="9">agents trace 71bb3b3b --errors-only</text>
  <rect x="330" y="64" width="260" height="176" rx="4" fill="#0a0a0a"/>
  <g font-family="JetBrains Mono, monospace" font-size="8.5">
    <text x="340" y="80" fill="#7c8894">71bb3b3b claude·opus-4.8 · 14m · 47 tools</text>
    <text x="340" y="96" fill="#e0b341">idle 3m10s after step 6 (stall)</text>
    <text x="340" y="116" fill="#8b98a5">03 Read  exec.ts                 0.2s ok</text>
    <text x="340" y="130" fill="#f87171">04 Bash  bun test exec.test.ts   8m04 ✗ x3</text>
    <text x="352" y="144" fill="#6e7681">exit 1 · 2 failing: resolves,rotate</text>
    <text x="340" y="158" fill="#8b98a5">05 Edit  exec.ts                 ok</text>
    <text x="340" y="172" fill="#7ee787">06 Bash  bun test → pass         1m40</text>
    <text x="340" y="192" fill="#a3e635">where the time went: Bash 61% Task 22%</text>
    <text x="340" y="212" fill="#7c8894">verdict: recovered after 1 fix loop</text>
    <text x="340" y="228" fill="#6e7681">~40 lines, token-bounded, no ANSI</text>
  </g>

  <!-- machine -->
  <rect x="618" y="14" width="288" height="272" rx="8" fill="#0d1117" stroke="#2a3a44" stroke-width="1"/>
  <text x="632" y="38" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="bold">MACHINE — --json</text>
  <text x="632" y="54" fill="#6e7681" font-family="JetBrains Mono, monospace" font-size="9">agents trace 71bb3b3b --json</text>
  <rect x="632" y="64" width="260" height="176" rx="4" fill="#0a0a0a"/>
  <g font-family="JetBrains Mono, monospace" font-size="8">
    <text x="642" y="80" fill="#8b98a5">{</text>
    <text x="650" y="92" fill="#7c8894">"kind":"sessions-trajectory",</text>
    <text x="650" y="104" fill="#7c8894">"schemaVersion":1,"layout":"single",</text>
    <text x="650" y="116" fill="#7c8894">"sessions":[{"spanMs":862000,</text>
    <text x="658" y="128" fill="#7c8894">"steps":[{"ordinal":4,"tool":"Bash",</text>
    <text x="666" y="140" fill="#7c8894">"startMs":41000,"durationMs":484000,</text>
    <text x="666" y="152" fill="#f87171">"outcome":"error","durationEstimated"</text>
    <text x="666" y="164" fill="#7c8894">:false,"outputTokens":18400}],</text>
    <text x="658" y="176" fill="#7c8894">"gaps":[{"startMs":..,"durationMs":..}],</text>
    <text x="658" y="188" fill="#7c8894">"toolTimeShare":{"Bash":0.61,..}}]}</text>
    <text x="642" y="212" fill="#8b98a5">the AGI EXT Fleet panel + any tool</text>
    <text x="642" y="226" fill="#6e7681">consume this — never re-parse a transcript</text>
  </g>
</svg>
</div>

## Current architecture — and the one gap

The reader already does all the hard parsing. Every harness's native transcript (Claude/Codex JSONL, Gemini JSON, Antigravity/OpenCode SQLite) is normalized by `parseSession` into one `SessionEvent[]`, and a shelf of pure extractors already reads that stream. The gap is narrow and specific: **nothing turns those events into a visual, and no code computes a per-step duration.** `render` stops at Markdown; `render -o out.html` is rejected outright.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 900 340" role="img" aria-label="Data flow: per-harness parsers normalize to SessionEvent[], feeding existing extractors and the Markdown renderer; the new trajectory model, HTML renderer, and viz command are the only additions" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#5a6b76"/></marker>
    <marker id="ag" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#a3e635"/></marker>
  </defs>
  <text x="20" y="22" fill="#7c8894" font-family="Inter, system-ui, sans-serif" font-size="11">EXISTS — reuse as-is</text>
  <rect x="20" y="32" width="150" height="64" rx="8" fill="#0f160a" stroke="#3a4a3a" stroke-width="1.3"/>
  <text x="30" y="52" fill="#d7e0e6" font-family="JetBrains Mono, monospace" font-size="10">12 harness parsers</text>
  <text x="30" y="68" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="9">parse.ts:178</text>
  <text x="30" y="84" fill="#6e7681" font-family="Inter, system-ui, sans-serif" font-size="9">claude…muse</text>
  <line x1="170" y1="64" x2="214" y2="64" stroke="#a3e635" stroke-width="1.4" marker-end="url(#ag)"/>
  <rect x="214" y="32" width="160" height="64" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="224" y="52" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">SessionEvent[]</text>
  <text x="224" y="68" fill="#8b98a5" font-family="JetBrains Mono, monospace" font-size="9">types.ts:46</text>
  <text x="224" y="84" fill="#6e7681" font-family="Inter, system-ui, sans-serif" font-size="9">callId · timestamp · outcome</text>
  <line x1="374" y1="52" x2="470" y2="40" stroke="#5a6b76" stroke-width="1.2" marker-end="url(#a)"/>
  <line x1="374" y1="64" x2="470" y2="64" stroke="#5a6b76" stroke-width="1.2" marker-end="url(#a)"/>
  <line x1="374" y1="76" x2="470" y2="88" stroke="#5a6b76" stroke-width="1.2" marker-end="url(#a)"/>
  <rect x="470" y="24" width="200" height="26" rx="6" fill="#0d1117" stroke="#2a3a44" stroke-width="1"/>
  <text x="480" y="41" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="9">toolCallsFromEvents · tool-calls.ts:546</text>
  <rect x="470" y="54" width="200" height="26" rx="6" fill="#0d1117" stroke="#2a3a44" stroke-width="1"/>
  <text x="480" y="71" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="9">computeSummaryStats · render.ts:203</text>
  <rect x="470" y="84" width="200" height="26" rx="6" fill="#0d1117" stroke="#2a3a44" stroke-width="1"/>
  <text x="480" y="101" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="9">digest · highlights · state · team-filter</text>
  <line x1="374" y1="88" x2="374" y2="150" stroke="#5a6b76" stroke-width="1.2" marker-end="url(#a)"/>
  <rect x="284" y="152" width="200" height="44" rx="8" fill="#0d1117" stroke="#2a3a44" stroke-width="1"/>
  <text x="294" y="172" fill="#adbac7" font-family="JetBrains Mono, monospace" font-size="10">renderSessionMarkdown…</text>
  <text x="294" y="188" fill="#e0b341" font-family="Inter, system-ui, sans-serif" font-size="9">Markdown only — the wall</text>
  <text x="470" y="150" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="bold">NEW — this plan (4 files)</text>
  <line x1="670" y1="64" x2="712" y2="180" stroke="#a3e635" stroke-width="1.4" marker-end="url(#ag)"/>
  <rect x="500" y="162" width="200" height="48" rx="8" fill="#101a08" stroke="#a3e635" stroke-width="1.5"/>
  <text x="510" y="182" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">buildTrajectory()</text>
  <text x="510" y="198" fill="#8b98a5" font-family="Inter, system-ui, sans-serif" font-size="9">pairs callId → per-step duration, gaps, phases</text>
  <line x1="600" y1="210" x2="600" y2="244" stroke="#a3e635" stroke-width="1.3" marker-end="url(#ag)"/>
  <rect x="420" y="246" width="180" height="44" rx="8" fill="#101a08" stroke="#a3e635" stroke-width="1.4"/>
  <text x="430" y="266" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">renderTrajectoryHtml()</text>
  <text x="430" y="282" fill="#8b98a5" font-family="Inter, system-ui, sans-serif" font-size="9">self-contained, à la share-html.ts</text>
  <rect x="620" y="246" width="180" height="44" rx="8" fill="#101a08" stroke="#a3e635" stroke-width="1.4"/>
  <text x="630" y="266" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">sessions viz cmd</text>
  <text x="630" y="282" fill="#8b98a5" font-family="Inter, system-ui, sans-serif" font-size="9">--json emits the model · opens on host</text>
  <line x1="600" y1="268" x2="620" y2="268" stroke="#a3e635" stroke-width="1.3" marker-end="url(#ag)"/>
</svg>
</div>

| Piece | Status | Where |
| --- | --- | --- |
| Normalized events, all 12 harnesses | reuse | `parseSession` `parse.ts:194`, `SessionEvent` `types.ts:46` |
| Structured tool calls (callId-correlated, redacted) | reuse | `toolCallsFromEvents` `tool-calls.ts:546` |
| Aggregate stats + header line | reuse | `computeSummaryStats` `render.ts:203`, `renderSummaryHeader` `render.ts:281` |
| File deltas, bash mix, test verdict | reuse | `classifyFileChanges` / `bashToolCounts` / `detectTestResult` `digest.ts` |
| Skills, slash-commands, hooks, repos | reuse | `highlights.ts` |
| Self-contained HTML page conventions | reuse pattern | `share-html.ts` (`escapeHtml`, `buildChips`, page shell; inline CSS, no CDN) |
| Redaction | reuse | `knownSecretValuesFromEnv` + the render redaction path |
| Team lineage (parent/teammates) | reuse | `enrichTeamOrigins` / `groupSessionsByTeam` / `teamRowKind` `team-filter.ts` |
| **Per-step duration / timeline model** | **new** | `buildTrajectory()` — nothing computes this today |
| **Visual (waterfall / compare / lineage) renderer** | **new** | `renderTrajectoryHtml()` |
| **The `viz` command + `--json`** | **new** | `sessions-viz.ts` |

## Implementation

Four new modules and one registration line. No change to `SessionEvent`, the parsers, or the existing `--json` contracts — the trajectory model is *derived* from events, never a new field on them, and never touches the SQLite `tool_calls` index or its `TOOL_INDEX_VERSION`.

**1. The trajectory model — the one genuinely new computation** (`src/lib/session/trajectory.ts`). Pairs each `tool_use` with its `tool_result` by `callId` to get a real duration; falls back to next-event delta when a harness omits the result timestamp; flags idle gaps and phase segments. Joins the already-redacted `toolCallsFromEvents` output for each step's input/outcome.

```ts
// src/lib/session/trajectory.ts  (new, pure, unit-tested)
export interface TrajectoryStep {
  ordinal: number;
  kind: 'tool' | 'thinking' | 'message' | 'error';
  tool?: string;               // 'Bash' | 'Read' | 'Task' | …
  lane: string;                // the row it draws on (tool name, or 'think')
  startMs: number;             // ms from session start
  durationMs: number;          // paired tool_use→tool_result by callId; 0 if unpaired
  durationEstimated: boolean;  // true when fell back to next-event delta
  outcome?: 'ok' | 'error' | 'unknown';
  label: string;               // redacted one-line summary (command / path / subagent)
  delegation?: 'inline-task' | 'teammate'; // inline Task branch vs cross-session teammate
  outputTokens?: number;       // attributed from the nearest following usage event
  callId?: string;
}
export interface SessionTrajectory {
  session: SessionMeta;
  spanMs: number;
  steps: TrajectoryStep[];
  gaps: Array<{ startMs: number; durationMs: number }>;   // idle stalls
  toolTimeShare: Record<string, number>;                   // 'where the time went'
  stats: SessionStats;                                     // reused wholesale
}
export function buildTrajectory(events: SessionEvent[], meta: SessionMeta): SessionTrajectory;
```

**2. Compare + lineage builders** (`src/lib/session/trajectory-compare.ts`). `diffTrajectories(a, b)` aligns the two tool sequences and returns the first divergence + added/removed steps; `buildLineage(sessions)` turns a set of `SessionMeta` into `{ nodes, edges }` using the existing `enrichTeamOrigins` / `groupSessionsByTeam` (`team-filter.ts`) — which already resolve `spawnerSessionId` from teammates' `parentSessionId` — and `teamRowKind` to distinguish a real teammate from a bare SDK spawn.

**3. The visual renderer** (`src/lib/session/trajectory-html.ts`). Emits one self-contained HTML string — inline `<style>`, inline SVG waterfall, no CDN, no `artifacts-cli` dependency — exactly the constraints `share-html.ts` documents, reusing its `escapeHtml` (XSS-safe over untrusted transcript text) and `buildChips`. Three layouts off one model: `single` (waterfall + analysis + step rail), `compare` (stacked lanes + diff + table), `lineage` (node graph).

**4. The command** (`src/commands/sessions-viz.ts`), registered beside `render`:

```ts
// registered in commands/sessions.ts alongside registerSessionsRenderCommand,
// plus a thin top-level alias `agents trace` on the program (like registerInsights)
sessionsCmd
  .command('trace <selectors...>')
  .description('Visualize a session as a trajectory — a tool-call timeline you can read at a glance. Opens a visual for a person; prints a compact trajectory for an agent. Several selectors compare; a parent + its team draws the lineage.')
  .option('--html | --text | --json', 'Force a rendering (default: HTML on a TTY, text when piped)')
  .option('-o, --output <path>', 'Write the rendered output to a path')
  .option('--no-open', 'Do not open the HTML on the interactive host; just print the path')
  .option('--compare', 'Force the compare layout even for related sessions')
  .option('--tree', 'Force the lineage layout (parent + teammates)')
  .option('--errors-only', 'Collapse to error steps + their neighbours (great for agents)')
  .option('--no-redact', 'Local-only: skip redaction (never for a shared file)');
// setHelpSections: examples (one session / two sessions / a team / --errors-only for an agent) + notes
```

**Audience auto-selection** is the one behavioural rule: with no `--html/--text/--json`, the command opens HTML when stdout is a TTY (a human) and prints the compact text trajectory when piped or headless (an agent). Explicit flags always win. Reuses the existing selector resolution (`selectSessions` + `discoverSessions` via `optsWithGlobals()`, exactly as `render` does, `sessions-render.ts:126`), the redaction path, and the interactive-host open transport every other visual surface uses. `--json` prints the versioned `sessions-trajectory` envelope (shaped like the `sessions-stats` envelope, `sessions-stats.ts:197`) — the stable contract the AGI EXT Fleet panel and any triaging agent consume so nothing re-implements the parser (the "one engine, many consumers" rule). The top-level `agents trace` is a thin alias delegating to the same action, mirroring how `agents insights` aliases `agents sessions insights`.

## Delta spec (the contract after this lands)

- `agents sessions viz <selectors…>` MUST accept the same selector forms as `render` (short id, full id, query, `--since`/`-a` parent flags) and resolve them through `discoverSessions`/`selectSessions`.
- One resolved session MUST render the `single` trajectory; ≥2 unrelated → `compare`; a parent + its `teamOrigin`/`parentSessionId` descendants → `lineage` (overridable with `--compare` / `--tree`).
- The HTML MUST be self-contained (no external asset, script, or font fetch) and redacted by default, reusing the same redaction as `render`/`share` — so a `viz` file is as safe to share as a `share` page.
- `--json` MUST emit a versioned `sessions-trajectory` envelope (`{ schemaVersion, kind: 'sessions-trajectory', layout, sessions: SessionTrajectory[], lineage?, diff? }`) and MUST NOT alter the existing `{ session, events }` render JSON (`render.ts:1142`) or the `sessions-stats` / list contracts.
- Duration MUST be derived (callId pairing; documented fallback), never persisted onto `SessionEvent` or the `tool_calls` table. `durationEstimated` MUST mark any fallback so consumers can distinguish measured from inferred.
- Coverage MUST be all of `SESSION_AGENTS`; a harness with no parser (OpenClaw today, `parse.ts:186`) MUST degrade to "no events to visualize," never a crash or a fabricated timeline.

## Tasks

1. `src/lib/session/trajectory.ts` — `buildTrajectory()` + types; callId pairing, gap/phase detection, token attribution, delegation tagging. Pure. **New.**
2. `src/lib/session/trajectory.test.ts` — real fixtures per harness shape (paired result, unpaired/estimated, callId-less harness, concurrent callIds, idle gap, error retry). **New.**
3. `src/lib/session/trajectory-compare.ts` — `diffTrajectories()` + `buildLineage()` (over `enrichTeamOrigins`/`groupSessionsByTeam`). **New.**
4. `src/lib/session/trajectory-compare.test.ts` — divergence point, added/removed steps, lineage edge discovery from a real team's `parentSessionId`. **New.**
5. `src/lib/session/trajectory-html.ts` — `renderTrajectoryHtml(model, layout)`; single/compare/lineage; self-contained per `share-html.ts` conventions (`escapeHtml`/`buildChips`). **New.**
6. `src/lib/session/trajectory-text.ts` — `renderTrajectoryText(model, { errorsOnly })`; the compact, token-bounded, ANSI-free agent/terminal rendering. **New.**
7. `src/lib/session/trajectory-html.test.ts` + `trajectory-text.test.ts` — HTML: zero external URLs, redaction, all layouts; text: bounded length, errors-only collapse, redaction. **New.**
8. `src/commands/sessions-trace.ts` — the command; selector resolution, layout auto-select, **audience auto-select by TTY**, `--json` envelope, open-on-host. `setHelpSections`. **New.**
9. `src/commands/sessions-trace.test.ts` — layout + audience selection; `--json` shape; `--no-open` prints path. **New.**
10. Register in `src/commands/sessions.ts` (canonical `registerSessionsTraceCommand(sessionsCmd)`) **and** a top-level `agents trace` alias on the program (mirror `registerInsights`). **Edit.**
11. Docs + CHANGELOG: `apps/cli/README.md` command list, `apps/cli/docs/sessions.md`, a `sessions-trajectory` requirement in `docs/specifications.md` §Sessions (a `SES-IF-4d`-style id), CHANGELOG entry. **Edit.**
12. Companion audit: check `.agents-system` sessions/debug skills for a place to teach `trace` (per the "core command groups stay in sync" review rule); land the guidance edit or state no consumer. **Edit/verify.**

## Edge cases

- **No paired result** (harness omits `tool_result` timestamp, or the call is still running): `durationMs` from next-event delta, `durationEstimated: true`, rendered with a hatched bar so measured vs inferred is visible.
- **callId-less harness** (single-JSON Gemini): fall back to ordinal order, duration omitted — never a wrong pairing, matching `ToolCallCollector.takePending`'s refusal to attach concurrent output by arrival order (`tool-calls.ts:509`).
- **Concurrent tool calls** (same turn fires several): correlate strictly by `callId` (`types.ts:53`), never by order; overlapping bars are correct and shown as such.
- **Two delegation shapes:** an inline `Task` sub-agent is a `tool_use` row whose own transcript is never indexed (`team-filter.ts:234`) → draw as an inline branch; a `teams` teammate is a separate `parentSessionId`-linked session → a lineage node. Do not conflate them.
- **Running session:** last step is open-ended; render a live/unbounded bar, header shows `running`.
- **Team sessions hidden by default** (invariant #7): `--tree`/lineage must discover with teams included and run `enrichTeamOrigins`, or children won't resolve.
- **Remote `_remote` rows** (`types.ts:349`): transcript lives on a peer; render locally-readable ones, note the remote ones (or require `--local`), mirroring the read/resume split in CLAUDE.md §"Resume is machine-bound."
- **Huge sessions** (10K+ events, `TOOL_CHANGED_MAX_CALLS`): cap drawn bars, bucket the tail, and print what was collapsed — no silent truncation.
- **OpenClaw / unparseable:** `parse.ts:186` returns `[]`; `viz` says "no events to visualize" and exits cleanly.
- **Redaction:** default on; `--no-redact` only for a local path; the emitted file carries the same masking as `share`.

## Testing

- Unit: `buildTrajectory` on real per-harness fixtures (Claude JSONL, Codex, a callId-less shape) — paired duration, estimated fallback, gap detection, token attribution.
- Unit: `diffTrajectories` divergence point on a passing-vs-failing pair; `buildLineage` edges from a real team's `parentSessionId`/`teamOrigin`.
- Unit: `renderTrajectoryHtml` emits zero external URLs (CSP-safe) and applies redaction for all three layouts.
- Integration: `agents sessions viz <id> --json` shape; `<id1> <id2>` → compare; a real team parent → lineage; `--no-open` prints a path that exists and opens in a browser.
- End-to-end: render a real recent session, open it on zion, eyeball the waterfall against `sessions render` of the same session — bars must match the transcript's tool order and the error must land on the right step.

## Purpose

Agents stall, loop, burn tokens, and hand work back — and today the only lens on *why* is `agents sessions render`, a linear Markdown wall with no timing and no shape. A debugger for agent runs is core to this repo's stated purpose (keep agents running, land work end to end). `viz` gives that lens: see one run's trajectory at a glance, and lay several side by side to see where a passing run and a failing one diverge — the visual debugger the removed Rush "Sessions Inspector" used to provide, rebuilt on agents-cli's own normalized model so it covers every harness.

## Proposed Changes

- Add `agents sessions viz <selectors…>` (`src/commands/sessions-viz.ts`), registered beside `render`.
- Add the derived trajectory model `buildTrajectory()` (`src/lib/session/trajectory.ts`) — the one new computation, pairing `tool_use`↔`tool_result` on `callId` for per-step duration.
- Add `diffTrajectories()` + `buildLineage()` (`src/lib/session/trajectory-compare.ts`) over the existing `team-filter.ts` lineage helpers.
- Add the self-contained visual renderer `renderTrajectoryHtml()` (`src/lib/session/trajectory-html.ts`), following `share-html.ts` conventions (inline CSS/SVG, no CDN, redaction-safe), with three layouts: single / compare / lineage.
- No change to `SessionEvent`, the parsers, the SQLite `tool_calls` index, or the existing `--json` contracts. Full detail under [Implementation](#implementation).

## Public Interface

```
agents sessions trace <selectors...>     (alias: agents trace <selectors...>)
  --html | --text | --json   Force a rendering (default: HTML on TTY, text when piped)
  -o, --output <path>        Write the rendered output to a path
  --no-open                  Print the path; do not open on the interactive host
  --compare                  Force the compare layout
  --tree                     Force the lineage layout (parent + teammates)
  --errors-only              Collapse to error steps + neighbours
  --no-redact                Local-only: skip redaction
```

- **Audience default:** no render flag → HTML when stdout is a TTY (human), compact text when piped/headless (agent). `--html/--text/--json` override.
- **Layout auto-select:** one selector → `single`; ≥2 unrelated → `compare`; a parent + its team → `lineage` (overridable with `--compare`/`--tree`).
- `--json` emits a versioned envelope: `{ schemaVersion, kind: 'sessions-trajectory', layout, sessions: SessionTrajectory[], lineage?, diff? }` — the stable contract for the AGI EXT Fleet panel and triaging agents. It does not alter the `{ session, events }` render JSON or the `sessions-stats`/list shapes.
- Top-level `agents trace` is a thin alias of `agents sessions trace` (precedent: `agents insights`).

## Validation

See [Testing](#testing) for the full matrix. In short: unit tests for `buildTrajectory` (paired/estimated durations, gaps, token attribution) across real per-harness fixtures; `diffTrajectories`/`buildLineage`; a CSP-safe assertion (zero external URLs) and redaction on the renderer; integration for layout auto-selection and `--json` shape; and an end-to-end eyeball of a real session's waterfall against its `render` output on zion.

## Risks

- **Duration accuracy on callId-less harnesses.** Gemini's single-JSON parser may not emit `callId`; those steps fall back to ordinal order with duration omitted (`durationEstimated`/omitted), never a wrong pairing. Named and bounded, not hidden.
- **Huge sessions** could produce an unwieldy page; mitigated by capping/bucketing with an explicit "collapsed N" note (no silent truncation).
- **Scope creep into a live/streaming viewer.** Explicitly out of v1 — `viz` reads a transcript; live is `sessions tail`/`watch`. The `--json` model leaves the door open for the ext to build a live view later without duplicating the parser.
- **Redaction regressions** would make a shared `viz` file leak; mitigated by reusing the exact `render`/`share` redaction path rather than a new one, and a renderer test asserting masking.

## Verification

Independent, blinded — each planner got only the ask + the data-model facts, never this approach.

- **A fresh-context architect converged almost exactly** on this design: same placement (a new verb nested under `sessions`), the same reuse set (`discoverSessions`/`selectSessions`, `parseSession`, `toolCallsFromEvents`→`IndexedToolCall`, `computeSummaryStats`/`renderSummaryHeader`, `digest.ts`, `highlights.ts`, `share-html.ts`), and — independently — the *same* single new computation: pairing `tool_use`↔`tool_result` on `callId` for per-call duration, because "the indexed tool-call stores only a start timestamp." It reached the same versioned-envelope JSON contract and the same edge cases (callId-less fallback, concurrent-call safety, huge-session caps, redaction default-on).
- **Where it diverged, and what I took from it.** (1) It named the command `trace`, not `viz` — a genuine naming call, surfaced above for you. (2) It made a *terminal* spine the default with HTML behind `--html`; I keep HTML primary because the ask is explicitly for the visual UI, but I adopted its terminal view as `--text`. (3) It surfaced three things I folded in: the **inline-`Task` vs teammate-session** distinction (now drawn differently), the exact lineage helpers `enrichTeamOrigins`/`groupSessionsByTeam`/`teamRowKind` (`team-filter.ts`), and the `_remote` peer-transcript edge case.
- **The convergence is the signal:** two independent derivations landing on the same reuse surface and the same one-new-function shape means the plan is anchored in the code, not invented. A second external planner (Antigravity, plan mode) failed to register a resolvable session — a silent dispatch failure, not a green track — so it is not counted here.

<!-- agents-plan -->
