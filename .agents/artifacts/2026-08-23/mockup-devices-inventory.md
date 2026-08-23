---
kind: plan
title: 'agents devices — describable, syncable, honest about capacity'
summary: 'Give every device a synced description, persist ignore state fleet-wide, and put real capacity numbers (cores, RAM, disk) in the default list — without adding a single SSH round trip.'
surface: cli
project: agents-cli
context: 'apps/cli — the devices command group'
repository: phnx-labs/agents-cli
branch: devices-inventory-plan
status: draft
date: '2026-08-23'
tracking: RUSH-3062
links:
  - url: https://linear.app/phnx/issue/RUSH-3062
    label: RUSH-3062
facts:
  - 'Zero new SSH round trips'
  - '4 parallel tracks'
  - 'Codex + Grok + Kimi'
---

## Focus for review

Four calls worth your input. Everything else I decide and note.

1. **Which layout becomes the default** — Option B is the recommendation; A and C are laid out below.
2. **`description` vs the existing `notes`** — there is already a `notes` key, a *list* of appended operator notes that is never rendered. Proposal: add a separate one-line `description` that renders, leave `notes` as long-form scratch.
3. **Role vocabulary** — today it is exactly `worker | personal`. Open it up (`build`, `gpu`, `ci`), or keep it as the two-value placement switch it is?
4. **Disk** — root volume only, or the largest volume? Root is simpler and matches what a worktree actually consumes.

## Purpose

Today `agents devices list` reports load and memory as bare percentages with no
denominator, so an agent choosing where to send work cannot tell a 36-core box
from an 8-core one — both read `1%`. Disk is not collected at all, so a box that
cannot fit a worktree looks identical to an idle one. And the two pieces of
operator knowledge that would fix this — what a machine is *for*, and which
discovered nodes to stop suggesting — either never render or never leave the
machine they were set on.

<div class="artifact-callout">
<strong>The load-bearing change is a denominator.</strong> Everything else follows from it: specs in the default view, disk alongside CPU and memory, and a one-line description so a box is identifiable by purpose rather than by hostname.
</div>

## Current architecture

The device surface already has most of the plumbing this needs. `role` and
`notes` live in the tracked per-device doc and travel fleet-wide today;
`fleet-status` already publishes one row per host on a 3-minute daemon tick with
no cross-host SSH. What is missing is three fields on the probe, one config key,
and a home for the ignore list that git actually tracks.

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <h4>Today</h4>
    <p>Percentages with no denominator. Cores and RAM exist only behind <code>-f/--full</code>; disk is not collected at all.</p>
    <svg viewBox="0 0 610 237" role="img" aria-label="agents devices list" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="610" height="237" rx="10" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
    <circle cx="22" cy="20" r="5" fill="#f85149" opacity="0.75"/>
    <circle cx="40" cy="20" r="5" fill="#e3b341" opacity="0.75"/>
    <circle cx="58" cy="20" r="5" fill="#7ee787" opacity="0.75"/>
    <text x="80" y="25" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">agents devices list</text>
    <line x1="0" y1="38" x2="610" y2="38" stroke="#30363d" stroke-width="1"/>
    <text x="24" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">device</text>
    <text x="140" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">platform</text>
    <text x="380" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">load</text>
    <text x="430" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">mem</text>
    <text x="500" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">headroom</text>
    <text x="24" y="87" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mac-mini</text>
    <text x="140" y="87" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="380" y="87" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">35%</text>
    <text x="430" y="87" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">55%</text>
    <text x="500" y="87" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="516" y="87" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="24" y="108" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mark-1</text>
    <text x="140" y="108" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="380" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="430" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">6%</text>
    <text x="500" y="108" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="516" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="24" y="129" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">win-mini</text>
    <text x="140" y="129" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">windows</text>
    <text x="380" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">6%</text>
    <text x="430" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">39%</text>
    <text x="500" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="516" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="24" y="150" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m0</text>
    <text x="140" y="150" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="380" y="150" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="430" y="150" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">8%</text>
    <text x="500" y="150" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="516" y="150" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="24" y="171" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-s0</text>
    <text x="140" y="171" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="380" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">3%</text>
    <text x="430" y="171" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">66%</text>
    <text x="500" y="171" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="516" y="171" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="10" y="192" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">▸</text>
    <text x="24" y="192" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">zion</text>
    <text x="140" y="192" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="380" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">24%</text>
    <text x="430" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">32%</text>
    <text x="500" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="516" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="24" y="221" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">no denominator anywhere</text>
  </svg>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <h4>Proposed — Option B</h4>
    <p>A <code>spec</code> cell carries the static hardware and <code>disk</code> joins load and mem. Role and description ride the tail — full list below.</p>
    <svg viewBox="0 0 610 237" role="img" aria-label="agents devices list" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="610" height="237" rx="10" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
    <circle cx="22" cy="20" r="5" fill="#f85149" opacity="0.75"/>
    <circle cx="40" cy="20" r="5" fill="#e3b341" opacity="0.75"/>
    <circle cx="58" cy="20" r="5" fill="#7ee787" opacity="0.75"/>
    <text x="80" y="25" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">agents devices list</text>
    <line x1="0" y1="38" x2="610" y2="38" stroke="#30363d" stroke-width="1"/>
    <text x="24" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">device</text>
    <text x="140" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">platform</text>
    <text x="228" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">spec</text>
    <text x="380" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">load</text>
    <text x="430" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">mem</text>
    <text x="480" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">disk</text>
    <text x="500" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">headroom</text>
    <text x="24" y="87" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mac-mini</text>
    <text x="140" y="87" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="228" y="87" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">12c 64G 1T</text>
    <text x="380" y="87" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">35%</text>
    <text x="430" y="87" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">55%</text>
    <text x="480" y="87" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">71%</text>
    <text x="500" y="87" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="516" y="87" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="24" y="108" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mark-1</text>
    <text x="140" y="108" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="228" y="108" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">36c 96G 2T</text>
    <text x="380" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="430" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">6%</text>
    <text x="480" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">8%</text>
    <text x="500" y="108" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="516" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="24" y="129" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">win-mini</text>
    <text x="140" y="129" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">windows</text>
    <text x="228" y="129" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">16c 32G 1T</text>
    <text x="380" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">6%</text>
    <text x="430" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">39%</text>
    <text x="480" y="129" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">44%</text>
    <text x="500" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="516" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="24" y="150" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m0</text>
    <text x="140" y="150" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="228" y="150" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8c 16G 256G</text>
    <text x="380" y="150" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="430" y="150" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">8%</text>
    <text x="480" y="150" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">12%</text>
    <text x="500" y="150" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="516" y="150" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="24" y="171" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-s0</text>
    <text x="140" y="171" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="228" y="171" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">32c 128G 2T</text>
    <text x="380" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">3%</text>
    <text x="430" y="171" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">66%</text>
    <text x="480" y="171" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">58%</text>
    <text x="500" y="171" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="516" y="171" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="10" y="192" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">▸</text>
    <text x="24" y="192" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">zion</text>
    <text x="140" y="192" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="228" y="192" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">16c 64G 2T</text>
    <text x="380" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">24%</text>
    <text x="430" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">32%</text>
    <text x="480" y="192" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">63%</text>
    <text x="500" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="516" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="24" y="221" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">every percentage has its denominator</text>
  </svg>
  </div>
</div>

### Option B in full

The whole fleet, every column, at the width a real terminal gives it.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg viewBox="0 0 1180 363" role="img" aria-label="agents devices list" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="1180" height="363" rx="10" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
    <circle cx="22" cy="20" r="5" fill="#f85149" opacity="0.75"/>
    <circle cx="40" cy="20" r="5" fill="#e3b341" opacity="0.75"/>
    <circle cx="58" cy="20" r="5" fill="#7ee787" opacity="0.75"/>
    <text x="80" y="25" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">agents devices list</text>
    <line x1="0" y1="38" x2="1180" y2="38" stroke="#30363d" stroke-width="1"/>
    <text x="28" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">device</text>
    <text x="160" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">platform</text>
    <text x="248" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">spec</text>
    <text x="390" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">load</text>
    <text x="450" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">mem</text>
    <text x="510" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">disk</text>
    <text x="545" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">headroom</text>
    <text x="650" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">role</text>
    <text x="740" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">description</text>
    <text x="28" y="87" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">ci-runner-fsn1</text>
    <text x="160" y="87" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="87" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">offline</text>
    <text x="650" y="87" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="87" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">hetzner CI runner</text>
    <text x="28" y="108" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mac-mini</text>
    <text x="160" y="108" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="248" y="108" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">12c 64G 1T</text>
    <text x="390" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">35%</text>
    <text x="450" y="108" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">55%</text>
    <text x="510" y="108" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">71%</text>
    <text x="545" y="108" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="108" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="650" y="108" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="108" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">signing + notarize box</text>
    <text x="28" y="129" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mark-1</text>
    <text x="160" y="129" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="129" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">36c 96G 2T</text>
    <text x="390" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="450" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">6%</text>
    <text x="510" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">8%</text>
    <text x="545" y="129" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="561" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="650" y="129" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="129" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">gpu box - cuda 12.4</text>
    <text x="28" y="150" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">pinnacles</text>
    <text x="160" y="150" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="248" y="150" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">offline</text>
    <text x="740" y="150" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">spare mac, usually off</text>
    <text x="28" y="171" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">win-mini</text>
    <text x="160" y="171" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">windows</text>
    <text x="248" y="171" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">16c 32G 1T</text>
    <text x="390" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">6%</text>
    <text x="450" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">39%</text>
    <text x="510" y="171" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">44%</text>
    <text x="545" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="650" y="171" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="171" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">only windows box - win-only tests</text>
    <text x="28" y="192" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m0</text>
    <text x="160" y="192" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="192" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8c 16G 256G</text>
    <text x="390" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="450" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">8%</text>
    <text x="510" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">12%</text>
    <text x="545" y="192" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="561" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="650" y="192" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="192" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">burst pool</text>
    <text x="28" y="213" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m1</text>
    <text x="160" y="213" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="213" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8c 16G 256G</text>
    <text x="390" y="213" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">0%</text>
    <text x="450" y="213" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">5%</text>
    <text x="510" y="213" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">11%</text>
    <text x="545" y="213" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="561" y="213" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="650" y="213" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="213" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">burst pool</text>
    <text x="28" y="234" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m2</text>
    <text x="160" y="234" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="234" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8c 16G 256G</text>
    <text x="390" y="234" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="450" y="234" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">5%</text>
    <text x="510" y="234" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">11%</text>
    <text x="545" y="234" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="561" y="234" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="650" y="234" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="234" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">burst pool</text>
    <text x="28" y="255" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-s0</text>
    <text x="160" y="255" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="255" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">32c 128G 2T</text>
    <text x="390" y="255" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">3%</text>
    <text x="450" y="255" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">66%</text>
    <text x="510" y="255" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">58%</text>
    <text x="545" y="255" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="255" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="650" y="255" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="255" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">long-running teams</text>
    <text x="28" y="276" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-s1</text>
    <text x="160" y="276" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="276" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">32c 128G 2T</text>
    <text x="390" y="276" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">15%</text>
    <text x="450" y="276" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">47%</text>
    <text x="510" y="276" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">52%</text>
    <text x="545" y="276" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="276" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="650" y="276" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">worker</text>
    <text x="740" y="276" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">long-running teams</text>
    <text x="12" y="297" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">▸</text>
    <text x="28" y="297" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">zion</text>
    <text x="160" y="297" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="248" y="297" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">16c 64G 2T</text>
    <text x="390" y="297" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">24%</text>
    <text x="450" y="297" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">32%</text>
    <text x="510" y="297" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">63%</text>
    <text x="545" y="297" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="297" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="650" y="297" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">personal</text>
    <text x="740" y="297" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">my laptop - never auto-place</text>
    <text x="990" y="297" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">← this machine</text>
    <text x="28" y="326" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">Fleet capacity: 200 cores · 418G free / 624G RAM (67% free) · 11T disk free across 13 reachable devices</text>
    <text x="28" y="347" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">1 device ignored (agents devices ignored) · specs cached, load updated 2m ago</text>
  </svg>
</figure>

### Where each field lives

| Field | Today | Proposed | Syncs fleet-wide |
| --- | --- | --- | --- |
| `role` (`worker` / `personal`) | tracked per-device doc | unchanged | yes, already |
| `notes` (list) | tracked per-device doc, **never rendered** | unchanged; stays long-form scratch | yes, already |
| **`description`** (one line) | — | tracked per-device doc, `config:` block | **yes, new** |
| **ignore list** | `~/.agents/.history/devices/ignored.json` — **gitignored** | central `~/.agents/agents.yaml` under `fleet.ignored` | **yes, new** |
| cores / RAM total / disk total | probed with the volatile stats | static tier, long TTL | n/a — per-box fact |
| load / mem / disk **used** | 3-min daemon publish | unchanged | n/a — per-box fact |

An ignored node is deliberately *not* a device — it never enters the registry —
so it cannot live in a per-device doc. Central `agents.yaml` is the tracked,
synced home that already carries `fleet.defaults`.

### How it stays cheap

Hardware facts change approximately never; load changes every second. Today they
ride the same probe and the same short TTL, so asking "how many cores does that
box have" costs exactly as much as asking "is it busy right now". Splitting the
two tiers is what makes the richer list free.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg viewBox="0 0 900 320" role="img" aria-label="Static specs cached long and volatile telemetry on the existing daemon tick, both feeding the devices list" preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b949e"/>
      </marker>
    </defs>

    <rect x="20" y="26" width="250" height="106" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="145" y="52" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">STATIC — specs</text>
    <text x="145" y="74" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">cores · RAM total · disk total</text>
    <text x="145" y="96" text-anchor="middle" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">TTL 7 days</text>
    <text x="145" y="115" text-anchor="middle" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">re-probed on reboot or --refresh</text>

    <rect x="20" y="176" width="250" height="106" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="145" y="202" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">VOLATILE — telemetry</text>
    <text x="145" y="224" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">load% · mem% · disk used%</text>
    <text x="145" y="246" text-anchor="middle" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">existing 3-minute daemon tick</text>
    <text x="145" y="265" text-anchor="middle" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">publish-own, zero cross-host SSH</text>

    <path d="M270 79 L 352 142" stroke="#a3e635" stroke-width="1.5" fill="none" marker-end="url(#arrow)"/>
    <path d="M270 229 L 352 176" stroke="#f59e0b" stroke-width="1.5" fill="none" marker-end="url(#arrow)"/>

    <rect x="352" y="120" width="218" height="76" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="461" y="148" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">fleet-status row</text>
    <text x="461" y="170" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="11">one row per host</text>
    <text x="461" y="187" text-anchor="middle" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">already crosses the fleet</text>

    <rect x="352" y="228" width="218" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="461" y="254" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">tracked config</text>
    <text x="461" y="276" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">description · role · ignored</text>

    <path d="M570 158 L 652 158" stroke="#38bdf8" stroke-width="1.5" fill="none" marker-end="url(#arrow)"/>
    <path d="M570 258 L 652 186" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7" fill="none" marker-end="url(#arrow)"/>

    <rect x="652" y="120" width="228" height="76" rx="8" fill="#0d1117" stroke="#c8c8c8" stroke-width="1.5"/>
    <text x="766" y="148" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">agents devices list</text>
    <text x="766" y="170" text-anchor="middle" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">reads the union</text>
    <text x="766" y="187" text-anchor="middle" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">no network on the read path</text>
  </svg>
  <figcaption>Left to right: two telemetry tiers with different refresh rates merge into the fleet-status row that already crosses the fleet; tracked config joins it at read time. Nothing new is dialed.</figcaption>
</figure>

**Net cost: zero new SSH round trips.** The POSIX probe is already one `sh -c`
running three commands. Disk becomes a fourth in the same invocation:

```diff
-const PROBE_SNIPPET = `uptime; echo ${SEP}; (vm_stat 2>/dev/null || cat /proc/meminfo 2>/dev/null); echo ${SEP}; (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)`;
+const PROBE_SNIPPET = `uptime; echo ${SEP}; (vm_stat 2>/dev/null || cat /proc/meminfo 2>/dev/null); echo ${SEP}; (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null); echo ${SEP}; df -k / 2>/dev/null | tail -1`;
```

## Proposed Changes

Option B above is the recommendation. The two alternatives, for comparison.

### Option A — capacity inline

Every percentage carries its denominator in the same cell.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg viewBox="0 0 880 332" role="img" aria-label="agents devices list" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="880" height="332" rx="10" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
    <circle cx="22" cy="20" r="5" fill="#f85149" opacity="0.75"/>
    <circle cx="40" cy="20" r="5" fill="#e3b341" opacity="0.75"/>
    <circle cx="58" cy="20" r="5" fill="#7ee787" opacity="0.75"/>
    <text x="80" y="25" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">agents devices list</text>
    <line x1="0" y1="38" x2="880" y2="38" stroke="#30363d" stroke-width="1"/>
    <text x="28" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">device</text>
    <text x="160" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">platform</text>
    <text x="250" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">cpu</text>
    <text x="400" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">mem</text>
    <text x="550" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">disk</text>
    <text x="690" y="62" fill="#8b949e" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">headroom</text>
    <text x="28" y="87" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">ci-runner-fsn1</text>
    <text x="160" y="87" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="250" y="87" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">offline</text>
    <text x="28" y="108" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mac-mini</text>
    <text x="160" y="108" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="250" y="108" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">35% of 12c</text>
    <text x="400" y="108" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">55% of 64G</text>
    <text x="550" y="108" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">71% of 1T</text>
    <text x="690" y="108" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="706" y="108" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="28" y="129" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mark-1</text>
    <text x="160" y="129" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="250" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">1% of 36c</text>
    <text x="400" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">6% of 96G</text>
    <text x="550" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8% of 2T</text>
    <text x="690" y="129" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="706" y="129" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="28" y="150" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">pinnacles</text>
    <text x="160" y="150" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="250" y="150" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">offline</text>
    <text x="28" y="171" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">win-mini</text>
    <text x="160" y="171" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">windows</text>
    <text x="250" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">6% of 16c</text>
    <text x="400" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">39% of 32G</text>
    <text x="550" y="171" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">44% of 1T</text>
    <text x="690" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="706" y="171" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="28" y="192" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m0</text>
    <text x="160" y="192" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="250" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">1% of 8c</text>
    <text x="400" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8% of 16G</text>
    <text x="550" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">12% of 256G</text>
    <text x="690" y="192" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="706" y="192" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="28" y="213" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m1</text>
    <text x="160" y="213" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="250" y="213" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">0% of 8c</text>
    <text x="400" y="213" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">5% of 16G</text>
    <text x="550" y="213" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">11% of 256G</text>
    <text x="690" y="213" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="706" y="213" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="28" y="234" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m2</text>
    <text x="160" y="234" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="250" y="234" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">1% of 8c</text>
    <text x="400" y="234" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">5% of 16G</text>
    <text x="550" y="234" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">11% of 256G</text>
    <text x="690" y="234" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="706" y="234" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="28" y="255" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-s0</text>
    <text x="160" y="255" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="250" y="255" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">3% of 32c</text>
    <text x="400" y="255" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">66% of 128G</text>
    <text x="550" y="255" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">58% of 2T</text>
    <text x="690" y="255" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="706" y="255" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="28" y="276" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-s1</text>
    <text x="160" y="276" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="250" y="276" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">15% of 32c</text>
    <text x="400" y="276" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">47% of 128G</text>
    <text x="550" y="276" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">52% of 2T</text>
    <text x="690" y="276" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="706" y="276" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="12" y="297" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">▸</text>
    <text x="28" y="297" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">zion</text>
    <text x="160" y="297" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="250" y="297" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">24% of 16c</text>
    <text x="400" y="297" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">32% of 64G</text>
    <text x="550" y="297" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">63% of 2T</text>
    <text x="690" y="297" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="706" y="297" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
  </svg>
</figure>

**Tradeoff:** the most readable single cell, but it burns ~96 columns before any
role or description, so the description has to move to a second line or be
dropped entirely.

### Option C — grouped by role

The same cells as B, but rows group under their role, so "where should this run"
is answered structurally rather than by scanning.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg viewBox="0 0 1100 404" role="img" aria-label="agents devices list" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="1100" height="404" rx="10" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
    <circle cx="22" cy="20" r="5" fill="#f85149" opacity="0.75"/>
    <circle cx="40" cy="20" r="5" fill="#e3b341" opacity="0.75"/>
    <circle cx="58" cy="20" r="5" fill="#7ee787" opacity="0.75"/>
    <text x="80" y="25" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">agents devices list</text>
    <line x1="0" y1="38" x2="1100" y2="38" stroke="#30363d" stroke-width="1"/>
    <text x="12" y="62" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">WORKERS (9)</text>
    <text x="650" y="62" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">176 cores · 380G free · 9T disk free</text>
    <text x="28" y="85" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mac-mini</text>
    <text x="160" y="85" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="248" y="85" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">12c 64G 1T</text>
    <text x="390" y="85" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">35%</text>
    <text x="450" y="85" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">55%</text>
    <text x="510" y="85" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">71%</text>
    <text x="545" y="85" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="85" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="650" y="85" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">signing + notarize box</text>
    <text x="28" y="106" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">mark-1</text>
    <text x="160" y="106" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="106" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">36c 96G 2T</text>
    <text x="390" y="106" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="450" y="106" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">6%</text>
    <text x="510" y="106" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">8%</text>
    <text x="545" y="106" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="561" y="106" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="650" y="106" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">gpu box - cuda 12.4</text>
    <text x="28" y="127" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">win-mini</text>
    <text x="160" y="127" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">windows</text>
    <text x="248" y="127" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">16c 32G 1T</text>
    <text x="390" y="127" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">6%</text>
    <text x="450" y="127" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">39%</text>
    <text x="510" y="127" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">44%</text>
    <text x="545" y="127" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="127" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="650" y="127" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">only windows box - win-only tests</text>
    <text x="28" y="148" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m0</text>
    <text x="160" y="148" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="148" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8c 16G 256G</text>
    <text x="390" y="148" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="450" y="148" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">8%</text>
    <text x="510" y="148" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">12%</text>
    <text x="545" y="148" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="561" y="148" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="650" y="148" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">burst pool</text>
    <text x="28" y="169" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m1</text>
    <text x="160" y="169" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="169" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8c 16G 256G</text>
    <text x="390" y="169" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">0%</text>
    <text x="450" y="169" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">5%</text>
    <text x="510" y="169" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">11%</text>
    <text x="545" y="169" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="561" y="169" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="650" y="169" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">burst pool</text>
    <text x="28" y="190" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-m2</text>
    <text x="160" y="190" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="190" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">8c 16G 256G</text>
    <text x="390" y="190" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">1%</text>
    <text x="450" y="190" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">5%</text>
    <text x="510" y="190" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">11%</text>
    <text x="545" y="190" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">o</text>
    <text x="561" y="190" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">idle</text>
    <text x="650" y="190" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">burst pool</text>
    <text x="28" y="211" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-s0</text>
    <text x="160" y="211" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="211" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">32c 128G 2T</text>
    <text x="390" y="211" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">3%</text>
    <text x="450" y="211" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">66%</text>
    <text x="510" y="211" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">58%</text>
    <text x="545" y="211" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="211" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="650" y="211" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">long-running teams</text>
    <text x="28" y="232" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">yosemite-s1</text>
    <text x="160" y="232" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="232" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">32c 128G 2T</text>
    <text x="390" y="232" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">15%</text>
    <text x="450" y="232" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">47%</text>
    <text x="510" y="232" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">52%</text>
    <text x="545" y="232" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="232" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">busy</text>
    <text x="650" y="232" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">long-running teams</text>
    <text x="12" y="265" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">PERSONAL (1)</text>
    <text x="650" y="265" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">never picked by --device auto</text>
    <text x="12" y="288" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">▸</text>
    <text x="28" y="288" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">zion</text>
    <text x="160" y="288" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="248" y="288" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">16c 64G 2T</text>
    <text x="390" y="288" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">24%</text>
    <text x="450" y="288" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">32%</text>
    <text x="510" y="288" fill="#e3b341" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="end">63%</text>
    <text x="545" y="288" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">*</text>
    <text x="561" y="288" fill="#7ee787" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">light</text>
    <text x="650" y="288" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">my laptop - never auto-place</text>
    <text x="900" y="288" fill="#56d4dd" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">← this machine</text>
    <text x="12" y="321" fill="#a3e635" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">OFFLINE (2)</text>
    <text x="28" y="344" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">ci-runner-fsn1</text>
    <text x="160" y="344" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">linux</text>
    <text x="248" y="344" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">last seen 3d ago</text>
    <text x="650" y="344" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">hetzner CI runner</text>
    <text x="28" y="365" fill="#e6e6d9" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" font-weight="bold">pinnacles</text>
    <text x="160" y="365" fill="#9aa5b8" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">macos</text>
    <text x="248" y="365" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">last seen 3d ago</text>
    <text x="650" y="365" fill="#6e7681" font-family="JetBrains Mono, ui-monospace, monospace" font-size="13">spare mac, usually off</text>
  </svg>
</figure>

**Tradeoff:** the strongest placement answer, and the per-group capacity
subtotals are genuinely useful. But it reorders a list people have muscle memory
for, and an unmarked fleet needs an `UNASSIGNED` group that makes the common case
look noisy.

## Public Interface

Two new commands, one new config key, three new `--json` fields. `describe` is
sugar over the existing config store, exactly as `role` is today.

```bash
agents devices describe mark-1 "gpu box — cuda 12.4, 4090"
agents devices config mark-1 description "gpu box — cuda 12.4, 4090"   # equivalent

agents devices ignore old-laptop      # now syncs fleet-wide
agents devices unignore old-laptop
agents devices ignored                # list dismissed nodes, with who ignored them and when
```

| Surface | Change | Compatibility |
| --- | --- | --- |
| `agents devices list` | `spec` and `disk` columns, description tail | additive; `--no-stats` unchanged |
| `agents devices list --json` | `+ description`, `+ stats.diskTotalBytes`, `+ stats.diskUsedPercent` | additive |
| `agents devices describe <name> <text>` | new | new name under an owned noun |
| `agents devices ignored` | new | new |
| `agents devices config <name> description` | new key | joins `role`, `notes` |
| `-f/--full` | keeps `free/total` memory detail | unchanged |

## Validation

| Check | How |
| --- | --- |
| Disk parsed on every platform | Unit tests over real `df -k` and `Win32_LogicalDisk` output fixtures for macOS, Linux, Windows |
| Static tier does not re-probe | Test asserts a second `devices list` inside the TTL issues zero probe calls |
| Description round-trips and syncs | Write on one box, `agents repo push`, read back on a peer — real fleet, not a mock |
| Ignore survives the move | Migration test: a legacy `ignored.json` folds into `fleet.ignored` once, then the legacy file is gone |
| No new SSH | Assert the probe snippet is still a single invocation; count round trips in the fleet-status test |
| The list still renders at 80 columns | Snapshot test at 80 / 120 / 200 columns |

## Risks

| Risk | Mitigation |
| --- | --- |
| `df` on a box with a network mount at `/` hangs the probe | The probe already carries a timeout; `df -k /` is local-only and `2>/dev/null` swallows a failure into "no disk signal" |
| Windows CIM line grows and breaks the existing parser | The parser is field-labelled (`load=`, `freeKb=`), not positional — a new labelled field is backward compatible, and the existing parser test pins that |
| Moving the ignore list loses a user's dismissals | One-shot migration reads the legacy file before writing the new location, same pattern `config-migration.ts` already uses; the legacy file is only removed after a successful write |
| Wider default output wraps on a narrow terminal | Description truncates first, then role; the numeric columns never truncate |
| Two agents write `fleet.ignored` concurrently | Central `agents.yaml` writes already go through `withMetaLock` + atomic write |

## Tracking

- [RUSH-3062](https://linear.app/phnx/issue/RUSH-3062) — agents devices: synced description + fleet-wide ignore, and real capacity in the default list

## Delivery

Four tracks, one worktree each, boundary contracts enforced by file ownership.

| Track | Owns | Must not touch | Harness |
| --- | --- | --- | --- |
| **specs** | `lib/devices/health.ts` — disk probe, `DeviceStats` fields, static/volatile TTL | `commands/ssh.ts`, `device-config.ts` | Codex |
| **config** | `lib/device-config.ts` `description` key, `agents devices describe`, docs | `health.ts`, ignore-list files | Kimi |
| **ignore** | `lib/devices/registry.ts` ignore list, migration, `agents devices ignored` | `health.ts`, `device-config.ts` key table | Grok |
| **render** | `commands/ssh.ts` `renderDeviceTable`, `--json` fields, help text | `health.ts` internals | Codex |

`render` runs after `specs` lands the fields. `config` and `ignore` are fully
independent and run in parallel from the start.
