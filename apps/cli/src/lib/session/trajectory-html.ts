/**
 * Render a {@link SessionTrajectory} as ONE self-contained HTML page for
 * `agents sessions trace` (single-session layout): an analysis hero — where
 * the time went, slowest steps, a program-aware tool mix, and headline KPIs —
 * followed by the trajectory itself, drawn STEP-ORDERED (never a wall-clock
 * axis): one row per step, badged by its effective shell program (`git`,
 * `gh`, `bun`, …) when the step is a shell call, folded runs of fast
 * same-program calls, and idle gaps rendered as centered dividers.
 *
 * Self-contained on purpose, exactly like `share-html.ts`: an inline `<style>`,
 * no external asset, no CDN, no web font, no `artifacts-cli` dependency. The
 * page is safe to open on any box or hand to a person. All transcript-derived
 * text is escaped with `escapeHtml`, and the labels are already
 * secret-redacted upstream in `buildTrajectory`.
 *
 * Terminal-coded per the agents-cli brand (#0a0a0a bg, #a3e635 lime accent,
 * JetBrains Mono), light theme under `prefers-color-scheme: light`, with an
 * in-page toggle — the same shell `share-html.ts` ships.
 */
import { formatDuration, formatTokenCount } from './render.js';
import { escapeHtml } from './share-html.js';
import type { SessionTrajectory, TrajectoryStep } from './trajectory.js';
import type { TrajectoryComparison } from './trajectory-compare.js';
import type { LineageNode, SessionLineage } from './trajectory-lineage.js';

/** Precise per-step duration: "8m04s", "1.6s", "320ms". */
function formatStepDuration(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** Axis tick labels in minutes across the span. */
function axisTicks(spanMs: number, count = 4): Array<{ frac: number; label: string }> {
  if (spanMs <= 0) return [{ frac: 0, label: '0m' }];
  const ticks: Array<{ frac: number; label: string }> = [];
  for (let i = 0; i <= count; i++) {
    const frac = i / count;
    const min = (spanMs * frac) / 60_000;
    ticks.push({ frac, label: min >= 1 ? `${Math.round(min)}m` : `${Math.round(spanMs * frac / 1000)}s` });
  }
  return ticks;
}

interface WaterfallGeometry {
  labelW: number;
  chartW: number;
  rowH: number;
  top: number;
}

const GEO: WaterfallGeometry = { labelW: 84, chartW: 620, rowH: 20, top: 34 };

function clipLabel(label: string, max = 46): string {
  const oneLine = label.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Per-tool family color — the fallback badge color when a step has no `program`. */
const FAMILY_COLOR: Record<string, string> = {
  bash: '#e0b341', shell: '#e0b341', run_command: '#e0b341', run_shell_command: '#e0b341', exec: '#e0b341', execute: '#e0b341', exec_command: '#e0b341',
  read: '#4a9eff', grep: '#4a9eff', glob: '#4a9eff', search: '#4a9eff', codebase_search: '#4a9eff',
  edit: '#7ee787', write: '#7ee787', notebookedit: '#7ee787', multiedit: '#7ee787',
  task: '#b98cff', agent: '#b98cff',
  taskcreate: '#6b8cff', taskupdate: '#6b8cff', taskget: '#6b8cff', tasklist: '#6b8cff',
  toolsearch: '#5ac8c8', websearch: '#5ac8c8', webfetch: '#5ac8c8',
};

/** Per-shell-program badge color — the primary key once `program` is known. */
const PROGRAM_COLOR: Record<string, string> = {
  agents: '#a3e635', 'agents-dev': '#a3e635', ag: '#a3e635',
  git: '#f0883e', gh: '#c9a0ff',
  bun: '#f471b5', npm: '#f471b5', npx: '#f471b5', node: '#8cc84b',
  python3: '#4a9eff', python: '#4a9eff',
  ls: '#8b98a5', sed: '#8b98a5', grep: '#8b98a5', rg: '#8b98a5', fd: '#8b98a5', cat: '#8b98a5', awk: '#8b98a5', find: '#8b98a5',
  scp: '#5ac8c8', ssh: '#5ac8c8', curl: '#5ac8c8', wget: '#5ac8c8',
  linear: '#6b8cff', mkdir: '#8b98a5', rm: '#f87171', chmod: '#8b98a5',
};

function familyColor(name: string): string {
  return FAMILY_COLOR[name.toLowerCase()] ?? '#8b98a5';
}

function programColor(program: string): string {
  return PROGRAM_COLOR[program] ?? '#e0b341';
}

/** The badge an execution-order row draws: a shell program when known, else the tool/kind. */
function stepBadge(step: TrajectoryStep): { label: string; color: string } {
  if (step.kind === 'tool' && step.program) return { label: step.program, color: programColor(step.program) };
  const name = step.tool ?? step.kind;
  return { label: name, color: familyColor(name) };
}

function durationClass(step: TrajectoryStep): 'fast' | 'mid' | 'slow' | 'err' {
  if (step.outcome === 'error') return 'err';
  if (step.durationMs < 1_000) return 'fast';
  if (step.durationMs < 15_000) return 'mid';
  return 'slow';
}

/** "Where the time went" — a horizontal stacked bar over `toolTimeShare`, plus legend. */
function renderTimeShareBar(model: SessionTrajectory): string {
  const entries = Object.entries(model.toolTimeShare).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '<p class="muted">No measured tool time.</p>';
  const segs = entries
    .filter(([, share]) => share > 0)
    .map(([tool, share]) => `<span class="seg" style="width:${(share * 100).toFixed(1)}%;background:${familyColor(tool)}" title="${escapeHtml(tool)} ${Math.round(share * 100)}%"></span>`)
    .join('');
  const legend = entries
    .filter(([, share]) => share > 0.01)
    .slice(0, 6)
    .map(([tool, share]) => `<span class="lg"><span class="dot" style="background:${familyColor(tool)}"></span>${escapeHtml(tool)} ${Math.round(share * 100)}%</span>`)
    .join(' &nbsp; ');
  return `<div class="timebar">${segs}</div><div class="legend">${legend}</div>`;
}

/** Top ~6 slowest measured steps, badge-colored by their effective program/tool. */
function renderSlowestSteps(model: SessionTrajectory, limit = 6): string {
  const slowest = model.steps
    .filter((s) => s.durationMs > 0)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit);
  if (slowest.length === 0) return '<p class="muted">No measured steps.</p>';
  return slowest.map((step) => {
    const badge = stepBadge(step);
    return `<div class="srow"><span class="sord">#${step.ordinal}</span>` +
      `<span class="stag" style="color:${badge.color}">${escapeHtml(badge.label)}</span>` +
      `<span class="slabel">${escapeHtml(clipLabel(step.label, 52))}</span>` +
      `<span class="sdur ${durationClass(step)}">${escapeHtml(formatStepDuration(step.durationMs))}</span></div>`;
  }).join('\n');
}

/** Tool-mix histogram — a Bash step is broken down by its EFFECTIVE program, never lumped as "Bash". */
function toolMixCounts(model: SessionTrajectory): Array<{ label: string; color: string; count: number }> {
  const counts = new Map<string, { color: string; count: number }>();
  for (const step of model.steps) {
    if (step.kind !== 'tool') continue;
    const badge = stepBadge(step);
    const existing = counts.get(badge.label);
    if (existing) existing.count += 1;
    else counts.set(badge.label, { color: badge.color, count: 1 });
  }
  return [...counts.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.count - a.count);
}

function renderToolMix(model: SessionTrajectory): string {
  const rows = toolMixCounts(model).slice(0, 8);
  if (rows.length === 0) return '<p class="muted">No tool calls.</p>';
  const max = Math.max(...rows.map((r) => r.count));
  return rows.map((r) => `<div class="hrow"><span class="hname">${escapeHtml(r.label)}</span>` +
    `<span class="hbar" style="width:${Math.round((r.count / max) * 100)}%;background:${r.color}"></span>` +
    `<span class="hval">${r.count}</span></div>`).join('\n');
}

function renderAnalysisKpis(model: SessionTrajectory): string {
  const idleTotal = model.gaps.reduce((n, g) => n + g.durationMs, 0);
  const longestGap = model.gaps.reduce((m, g) => Math.max(m, g.durationMs), 0);
  return `<div class="kpis">
      <div class="kpi"><div class="v${model.errorCount > 0 ? ' bad' : ''}">${model.errorCount}</div><div class="l">errors</div></div>
      <div class="kpi"><div class="v warn">${escapeHtml(formatStepDuration(idleTotal))}</div><div class="l">idle total</div></div>
      <div class="kpi"><div class="v">${escapeHtml(formatStepDuration(longestGap))}</div><div class="l">longest gap</div></div>
    </div>`;
}

/** The analysis hero: where the time went, slowest steps, tool mix, and headline KPIs. */
function renderAnalysisSection(model: SessionTrajectory): string {
  return `<section>
  <div class="stitle">Analysis</div>
  <div class="analysis">
    <div class="card"><h3>Where the time went</h3>
      ${renderTimeShareBar(model)}
      <div style="margin-top:14px"><h3 style="margin-bottom:8px">Slowest steps</h3>${renderSlowestSteps(model)}</div>
    </div>
    <div class="card"><h3>Tool mix</h3>${renderToolMix(model)}
      ${renderAnalysisKpis(model)}
    </div>
  </div>
</section>`;
}

/** One non-grouped step row — a `<details>` when it carries redacted output, else a plain block. */
function renderStepRow(step: TrajectoryStep): string {
  const badge = stepBadge(step);
  const cls = durationClass(step);
  const exitPart = step.outcome === 'error'
    ? (typeof step.exitCode === 'number' ? ` exit ${step.exitCode} &#10007;` : ' &#10007;')
    : '';
  const tokPart = step.outputTokens && step.outputTokens > 1000
    ? `<span class="tok">${Math.round(step.outputTokens / 1000)}K</span>`
    : '<span class="tok"></span>';
  const row = `<span class="ord">#${step.ordinal}</span>` +
    `<span class="badge" style="background:${badge.color}">${escapeHtml(badge.label)}</span>` +
    `<span class="lbl">${escapeHtml(clipLabel(step.label, 88))}</span>` +
    `${tokPart}` +
    `<span class="dur ${cls}">${escapeHtml(formatStepDuration(step.durationMs))}${exitPart}</span>`;
  const errCls = step.outcome === 'error' ? ' error' : '';
  if (step.detail) {
    return `<details class="step${errCls}"><summary>${row}</summary><div class="detail">${escapeHtml(step.detail)}</div></details>`;
  }
  return `<div class="step${errCls}"><div class="norow">${row}</div></div>`;
}

/** A folded run of ≥3 consecutive fast same-program/tool calls — one `<details>` with sub-rows. */
function renderGroupedRun(run: TrajectoryStep[]): string {
  const badge = stepBadge(run[0]);
  const total = run.reduce((n, s) => n + s.durationMs, 0);
  const inner = run.map((s) => `<div class="sub"><span class="ord">#${s.ordinal}</span>` +
    `<span class="lbl">${escapeHtml(clipLabel(s.label, 80))}</span>` +
    `<span class="dur ${durationClass(s)}">${escapeHtml(formatStepDuration(s.durationMs))}</span></div>`).join('\n');
  return `<details class="grp"><summary>` +
    `<span class="badge" style="background:${badge.color}">${escapeHtml(badge.label)}</span>` +
    `<span class="run">&#215;${run.length}</span>` +
    `<span class="glabel">${escapeHtml(run[0].tool ?? run[0].kind)} run &middot; ${escapeHtml(clipLabel(run[0].label, 40))} &#8230;</span>` +
    `<span class="dur mid">${escapeHtml(formatStepDuration(total))}</span></summary>${inner}</details>`;
}

/** The full step-ordered trajectory: rows, folded fast runs, and idle-gap dividers — NOT a wall-clock axis. */
function renderTrajectoryRows(model: SessionTrajectory): string {
  const { steps } = model;
  const gapsSorted = [...model.gaps].sort((a, b) => a.startMs - b.startMs);
  const rows: string[] = [];
  let gapIdx = 0;
  // A gap may fall BEFORE the first step (`afterOrdinal: 0`), so start `prevMs`
  // at the session origin, not `null` — else a leading stall is silently dropped.
  let prevMs = 0;
  const emitGapsBefore = (curMs: number): void => {
    while (gapIdx < gapsSorted.length && gapsSorted[gapIdx].startMs >= prevMs && gapsSorted[gapIdx].startMs < curMs) {
      rows.push(`<div class="gap">&#183;&#183;&#183;&nbsp;idle ${escapeHtml(formatStepDuration(gapsSorted[gapIdx].durationMs))}&nbsp;&#183;&#183;&#183;</div>`);
      gapIdx += 1;
    }
  };

  let i = 0;
  const n = steps.length;
  while (i < n) {
    const step = steps[i];
    emitGapsBefore(step.startMs);
    const badge0 = stepBadge(step);
    let j = i;
    if (step.kind === 'tool' && step.outcome !== 'error' && step.durationMs < 2_000) {
      while (j + 1 < n) {
        const next = steps[j + 1];
        if (next.kind !== 'tool' || next.outcome === 'error' || next.durationMs >= 2_000) break;
        if (stepBadge(next).label !== badge0.label) break;
        j += 1;
      }
    }
    const run = steps.slice(i, j + 1);
    rows.push(run.length > 2 ? renderGroupedRun(run) : run.map(renderStepRow).join('\n'));
    prevMs = step.startMs;
    i = j + 1;
  }
  emitGapsBefore(Number.POSITIVE_INFINITY);
  return rows.join('\n');
}

/** Render one session's trajectory as a self-contained HTML page — analysis hero on top, step-ordered trajectory below. */
export function renderTrajectoryHtml(model: SessionTrajectory): string {
  const { session, stats } = model;
  const title = `${session.agent} · ${session.shortId || session.id}`;
  const model2 = session.model ? escapeHtml(session.model) : '';
  const turns = stats.userTurns + stats.assistantTurns;
  const metrics: string[] = [];
  metrics.push(`${formatDuration(model.spanMs)}`);
  metrics.push(`${stats.toolCount} tool${stats.toolCount === 1 ? '' : 's'}`);
  if (model.errorCount > 0) metrics.push(`${model.errorCount} error${model.errorCount === 1 ? '' : 's'}`);
  if (stats.outputTokens > 0) metrics.push(`${formatTokenCount(stats.outputTokens)} out`);
  if (session.costUsd) metrics.push(`$${session.costUsd.toFixed(2)}`);
  metrics.push(`${turns} turn${turns === 1 ? '' : 's'}`);
  const metricLine = metrics.map((m) => escapeHtml(m)).join(' · ');

  const chips: string[] = [];
  if (session.project) chips.push(`<span class="chip"><span class="k">project</span>${escapeHtml(session.project)}</span>`);
  if (session.mode) chips.push(`<span class="chip"><span class="k">mode</span>${escapeHtml(session.mode)}</span>`);
  if (session.gitBranch) chips.push(`<span class="chip"><span class="k">branch</span>${escapeHtml(session.gitBranch)}</span>`);
  if (session.ticketId) chips.push(`<span class="chip"><span class="k">ticket</span>${escapeHtml(session.ticketId)}</span>`);
  const date = (session.timestamp || '').slice(0, 10);
  if (date) chips.push(`<span class="chip"><span class="k">date</span>${escapeHtml(date)}</span>`);

  const truncNote = model.truncatedSteps > 0
    ? `<p class="stall">Showing the first ${model.steps.length} steps; ${model.truncatedSteps} later step${model.truncatedSteps === 1 ? '' : 's'} collapsed.</p>`
    : '';
  const emptyNote = model.steps.length === 0 ? '<p class="muted">No events to visualize.</p>' : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} — trajectory</title>
<style>${BASE_STYLE}${TRAJECTORY_STYLE}</style>
</head>
<body>
<header>
  <div class="inner">
    <button class="toggle" id="theme" title="Toggle light and dark">&#9689;</button>
    <div class="mark">agents session trace</div>
    <h1>${escapeHtml(title)}${model2 ? ` <span class="muted">${model2}</span>` : ''}</h1>
    <div class="metrics">${metricLine}</div>
    <div class="chips">
      ${chips.join('\n      ')}
    </div>
  </div>
</header>
<main>
  ${renderAnalysisSection(model)}
  <section>
    <div class="stitle">Trajectory &middot; ${model.steps.length} step${model.steps.length === 1 ? '' : 's'}, execution order</div>
    ${truncNote}
    ${emptyNote}
    ${renderTrajectoryRows(model)}
    <p class="note">Consecutive fast same-program calls are folded — click to expand. Click any step with output to see its detail. Idle gaps shown as dividers, not on a wall-clock axis.</p>
  </section>
</main>
<footer>
  ${model.truncatedSteps > 0 ? 'Truncated · ' : ''}${model.redacted ? 'Secret-redacted' : 'Unredacted (local only)'} trajectory rendered by agents-cli &middot; <code>agents sessions trace</code>
</footer>
<script>${THEME_SCRIPT}</script>
</body>
</html>
`;
}

const BASE_STYLE = `
  :root {
    --bg: #0a0a0a; --panel: #121212; --border: #262626; --fg: #e5e5e5;
    --dim: #737373; --accent: #a3e635; --quote: #1a1a1a;
  }
  html[data-theme="light"] {
    --bg: #fafafa; --panel: #ffffff; --border: #e5e5e5; --fg: #171717;
    --dim: #737373; --accent: #4d7c0f; --quote: #f5f5f5;
  }
  @media (prefers-color-scheme: light) {
    html[data-theme="auto"] {
      --bg: #fafafa; --panel: #ffffff; --border: #e5e5e5; --fg: #171717;
      --dim: #737373; --accent: #4d7c0f; --quote: #f5f5f5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  header { border-bottom: 1px solid var(--border); padding: 24px 20px 18px; }
  header .inner, main { max-width: 960px; margin: 0 auto; }
  header .mark {
    color: var(--accent); font-weight: 700; letter-spacing: .5px; font-size: 12px;
    text-transform: uppercase; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
  header h1 { font-size: 20px; line-height: 1.3; margin: 8px 0 8px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
  .metrics { color: var(--dim); font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 13px; margin-bottom: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 11px;
    color: var(--fg); background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 2px 9px;
  }
  .chip .k { color: var(--dim); margin-right: 6px; }
  .toggle {
    float: right; cursor: pointer; background: none; border: 1px solid var(--border);
    color: var(--dim); border-radius: 6px; padding: 2px 8px; font-size: 14px;
  }
  main { padding: 20px 20px 64px; }
  h2 {
    font-size: 12px; color: var(--accent); border-bottom: 1px solid var(--border);
    padding-bottom: 6px; margin: 32px 0 14px; text-transform: uppercase;
    letter-spacing: 1px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
  .stall { color: #e0b341; font-size: 12.5px; margin: 6px 0; }
  .muted { color: var(--dim); }
  svg text { font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
  svg .axis { stroke: var(--border); stroke-width: 1; }
  svg .tick { fill: var(--dim); font-size: 8px; }
  svg .lane { fill: var(--dim); font-size: 9px; }
  svg a { cursor: pointer; }
  .dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  footer {
    max-width: 960px; margin: 0 auto; padding: 0 20px 48px;
    color: var(--dim); font-size: 12px;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
`;

/**
 * Single-session-only rules layered on top of {@link BASE_STYLE} — the analysis
 * hero (time-share bar, slowest steps, tool-mix histogram, KPIs) and the
 * step-ordered trajectory (badge rows, folded runs, idle-gap dividers).
 *
 * CRITICAL: the CSS grid lives on the ROW element (`.norow`, `details.step >
 * summary`, `details.grp > summary`) — never on the `<details>`/`.step`
 * container itself, which MUST stay `display:block`. A grid on the container
 * makes the expanded `.detail`/sub-rows inherit the row's column tracks and
 * collapse into a sliver instead of rendering full width.
 */
const TRAJECTORY_STYLE = `
  .stitle { color: var(--accent); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-bottom: 14px; }
  .analysis { display: grid; grid-template-columns: 1.3fr 1fr; gap: 22px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card h3 { margin: 0 0 10px; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .1em; font-weight: 500; }
  .timebar { display: flex; height: 14px; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
  .timebar .seg { height: 100%; }
  .legend { color: var(--dim); font-size: 11px; }
  .lg { white-space: nowrap; }
  .hrow { display: grid; grid-template-columns: 84px 1fr 34px; align-items: center; gap: 8px; margin: 4px 0; }
  .hname { color: var(--dim); font-size: 11px; }
  .hbar { height: 8px; border-radius: 3px; min-width: 2px; }
  .hval { color: var(--fg); font-size: 11px; text-align: right; }
  .srow { display: grid; grid-template-columns: 34px 62px 1fr auto; gap: 8px; align-items: center; margin: 5px 0; font-size: 12px; }
  .sord { color: var(--dim); opacity: .7; }
  .stag { font-size: 11px; font-weight: 600; }
  .slabel { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .kpis { display: flex; gap: 18px; margin-top: 2px; }
  .kpi .v { font-size: 22px; color: var(--fg); }
  .kpi .l { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .08em; }
  .kpi .v.bad { color: #f87171; }
  .kpi .v.warn { color: #e0b341; }
  /* Trajectory rows — grid on the ROW, block on the container (see docblock above). */
  .step, details.grp { display: block; }
  .norow, details.step > summary, details.grp > summary {
    display: grid; grid-template-columns: 40px 78px minmax(0, 1fr) 46px 76px; gap: 12px;
    align-items: center; padding: 6px 10px; border-radius: 7px;
  }
  details.step > summary, details.grp > summary { cursor: pointer; list-style: none; }
  details.step > summary::-webkit-details-marker, details.grp > summary::-webkit-details-marker { display: none; }
  .norow:hover, details.step > summary:hover, details.grp > summary:hover { background: var(--quote); }
  .step.error { border-left: 2px solid #b3403f; border-radius: 7px; }
  .ord { color: var(--dim); opacity: .7; font-size: 11px; }
  .badge { color: #0a0a0a; font-weight: 600; font-size: 10px; text-align: center; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
  .lbl { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tok { color: var(--dim); opacity: .7; font-size: 10px; }
  .dur { font-size: 12px; text-align: right; min-width: 68px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
  .dur.fast { color: var(--dim); }
  .dur.mid { color: #e0b341; }
  .dur.slow, .dur.err { color: #f87171; }
  .detail {
    white-space: pre-wrap; color: var(--dim); font-size: 11px; background: var(--bg);
    border-radius: 6px; padding: 8px 10px; margin: 2px 0 8px 54px; border: 1px solid var(--border);
    max-height: 240px; overflow: auto; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
  .grp > summary { color: var(--dim); }
  .grp .run { color: var(--accent); font-size: 11px; }
  .grp .glabel { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .grp .sub { display: grid; grid-template-columns: 44px 1fr auto; gap: 10px; padding: 3px 10px 3px 84px; font-size: 12px; color: var(--dim); }
  .gap { text-align: center; color: #a3833a; font-size: 11px; margin: 8px 0; letter-spacing: .06em; }
  .note { color: var(--dim); opacity: .8; font-size: 11px; margin-top: 10px; }
  @media (max-width: 760px) { .analysis { grid-template-columns: 1fr; } .norow, details.step > summary, details.grp > summary { grid-template-columns: 30px 64px minmax(0,1fr) 56px; } .tok { display: none; } }
`;

/** Compare-only rules layered on top of {@link BASE_STYLE} — lanes, divergence marker, summary table. */
const COMPARE_STYLE = `
  svg .diverge { stroke: #e0b341; stroke-width: 1.4; stroke-dasharray: 4 3; }
  .diverge-note { color: #e0b341; font-size: 12.5px; margin: 6px 0; }
  table.cmp-table { border-collapse: collapse; width: 100%; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12.5px; }
  table.cmp-table th, table.cmp-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  table.cmp-table th { color: var(--dim); font-weight: 600; text-transform: uppercase; font-size: 10.5px; letter-spacing: .5px; }
  .diff-cols { display: flex; gap: 24px; flex-wrap: wrap; }
  .diff-col { flex: 1; min-width: 260px; }
  .diff-col h3 { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; margin: 0 0 8px; }
  .diff-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .diff-list li {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12px;
    border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; background: var(--panel);
  }
`;

const THEME_SCRIPT = `
  (function () {
    var root = document.documentElement;
    var saved = null;
    try { saved = localStorage.getItem('agents-share-theme'); } catch (e) {}
    if (saved) root.setAttribute('data-theme', saved);
    var toggle = document.getElementById('theme');
    if (toggle) toggle.addEventListener('click', function () {
      var dark = getComputedStyle(root).getPropertyValue('--bg').trim() === '#0a0a0a';
      var next = dark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('agents-share-theme', next); } catch (e) {}
    });
  })();
`;

function compareTitle(cmp: TrajectoryComparison): string {
  const a = cmp.a.session;
  const b = cmp.b.session;
  return `${a.agent} ${a.shortId || a.id} vs ${b.agent} ${b.shortId || b.id}`;
}

function renderCompareWaterfallSvg(cmp: TrajectoryComparison): string {
  const { a, b, divergence } = cmp;
  const sharedSpan = Math.max(a.spanMs, b.spanMs, 1);
  const rowH = 26;
  const top = 34;
  const width = GEO.labelW + GEO.chartW + 40;
  const height = top + 2 * rowH + 16;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Compare waterfall: two sessions' tool calls on a shared time axis with a divergence marker" xmlns="http://www.w3.org/2000/svg">`);

  const axisY = top - 10;
  parts.push(`<line x1="${GEO.labelW}" y1="${axisY}" x2="${GEO.labelW + GEO.chartW}" y2="${axisY}" class="axis" />`);
  for (const tick of axisTicks(sharedSpan)) {
    const x = GEO.labelW + tick.frac * GEO.chartW;
    parts.push(`<text x="${x.toFixed(1)}" y="${axisY - 3}" class="tick">${escapeHtml(tick.label)}</text>`);
  }

  const lanes = [
    { session: a.session, steps: a.steps.filter((s) => s.kind === 'tool') },
    { session: b.session, steps: b.steps.filter((s) => s.kind === 'tool') },
  ];
  lanes.forEach((lane, li) => {
    const y = top + li * rowH;
    const barY = y + 5;
    const barH = rowH - 12;
    const label = `${lane.session.agent} ${lane.session.shortId || lane.session.id}`;
    parts.push(`<text x="${GEO.labelW - 6}" y="${y + rowH / 2 + 3}" class="lane" text-anchor="end">${escapeHtml(label)}</text>`);
    for (const step of lane.steps) {
      const x = GEO.labelW + Math.min(1, Math.max(0, step.startMs / sharedSpan)) * GEO.chartW;
      const w = Math.max(3, (step.durationMs / sharedSpan) * GEO.chartW);
      const badge = stepBadge(step);
      const dur = formatStepDuration(step.durationMs);
      const exitPart = step.outcome === 'error'
        ? (typeof step.exitCode === 'number' ? ` exit ${step.exitCode} ✗` : ' ✗')
        : '';
      parts.push(`<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barH}" rx="2" fill="${badge.color}"><title>${escapeHtml(label)} · step ${step.ordinal} · ${escapeHtml(badge.label)} · ${escapeHtml(dur)}${exitPart}</title></rect>`);
    }
  });

  if (divergence) {
    const dxA = GEO.labelW + Math.min(1, Math.max(0, divergence.startMsA / sharedSpan)) * GEO.chartW;
    const dxB = GEO.labelW + Math.min(1, Math.max(0, divergence.startMsB / sharedSpan)) * GEO.chartW;
    const dx = Math.min(dxA, dxB);
    parts.push(`<line x1="${dx.toFixed(1)}" y1="${top - 6}" x2="${dx.toFixed(1)}" y2="${top + 2 * rowH}" class="diverge"><title>diverge: ${escapeHtml(divergence.detail)}</title></line>`);
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function renderCompareSummaryTable(cmp: TrajectoryComparison): string {
  const rows = [cmp.summaryA, cmp.summaryB].map((s) => {
    const label = `${s.session.agent} ${s.session.shortId || s.session.id}`;
    return `<tr><td>${escapeHtml(label)}</td><td>${s.toolCount}</td><td>${s.errorCount}</td><td>${escapeHtml(formatDuration(s.spanMs))}</td><td>${escapeHtml(formatTokenCount(s.outputTokens))}</td></tr>`;
  }).join('\n');
  return `<table class="cmp-table"><thead><tr><th>session</th><th>tools</th><th>errors</th><th>duration</th><th>tokens</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderStepListItem(step: TrajectoryStep): string {
  const badge = stepBadge(step);
  const dur = formatStepDuration(step.durationMs);
  const exitPart = step.outcome === 'error'
    ? (typeof step.exitCode === 'number' ? ` exit ${step.exitCode} ✗` : ' ✗')
    : '';
  return `<li><span class="badge" style="background:${badge.color}">${escapeHtml(badge.label)}</span> ${escapeHtml(clipLabel(step.label))} <span class="muted">${escapeHtml(dur)}${escapeHtml(exitPart)}</span></li>`;
}

function renderCompareDiffLists(cmp: TrajectoryComparison): string {
  const aLabel = `${cmp.a.session.agent} ${cmp.a.session.shortId || cmp.a.session.id}`;
  const bLabel = `${cmp.b.session.agent} ${cmp.b.session.shortId || cmp.b.session.id}`;
  const removedItems = cmp.removed.length > 0
    ? cmp.removed.map(renderStepListItem).join('\n')
    : '<li class="muted">none</li>';
  const addedItems = cmp.added.length > 0
    ? cmp.added.map(renderStepListItem).join('\n')
    : '<li class="muted">none</li>';
  return `<div class="diff-cols">
    <div class="diff-col">
      <h3>Only in ${escapeHtml(aLabel)} (${cmp.removed.length})</h3>
      <ul class="diff-list">${removedItems}</ul>
    </div>
    <div class="diff-col">
      <h3>Only in ${escapeHtml(bLabel)} (${cmp.added.length})</h3>
      <ul class="diff-list">${addedItems}</ul>
    </div>
  </div>`;
}

/** Render a two-session {@link TrajectoryComparison} as a self-contained HTML page. */
export function renderTrajectoryCompareHtml(cmp: TrajectoryComparison): string {
  const title = compareTitle(cmp);
  const divergenceNote = cmp.divergence
    ? `<p class="diverge-note">◆ diverge after step ${cmp.divergence.afterOrdinalA}/${cmp.divergence.afterOrdinalB} — ${escapeHtml(cmp.divergence.detail)}</p>`
    : '<p class="muted">No divergence — the two tool sequences match.</p>';
  const truncNote = (cmp.truncatedA > 0 || cmp.truncatedB > 0)
    ? `<p class="stall">Diff capped — ${cmp.truncatedA} step${cmp.truncatedA === 1 ? '' : 's'} from the first and ${cmp.truncatedB} from the second were not compared.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} — compare</title>
<style>${BASE_STYLE}${COMPARE_STYLE}</style>
</head>
<body>
<header>
  <div class="inner">
    <button class="toggle" id="theme" title="Toggle light and dark">&#9689;</button>
    <div class="mark">agents session trace · compare</div>
    <h1>${escapeHtml(title)}</h1>
  </div>
</header>
<main>
  <h2>Trajectory</h2>
  ${truncNote}
  ${renderCompareWaterfallSvg(cmp)}
  ${divergenceNote}
  <h2>Summary</h2>
  ${renderCompareSummaryTable(cmp)}
  <h2>Step diff</h2>
  ${renderCompareDiffLists(cmp)}
</main>
<footer>
  Secret-redacted compare rendered by agents-cli &middot; <code>agents sessions trace</code>
</footer>
<script>${THEME_SCRIPT}</script>
</body>
</html>
`;
}

/** Lineage-only rules layered on top of {@link BASE_STYLE} — the node graph and its cards. */
const LINEAGE_STYLE = `
  .lineage-wrap { overflow-x: auto; }
  svg .lnode { cursor: pointer; }
  svg .lnode rect { fill: var(--panel); stroke-width: 1.3; }
  svg .lnode.selected rect { stroke-width: 2.4; }
  svg .lnode .n-id { font-size: 11px; }
  svg .lnode .n-sub { fill: var(--dim); font-size: 9px; }
  svg .ledge { stroke: #4a6b3a; stroke-width: 1.4; fill: none; }
  .lcards { margin-top: 4px; }
  .lcard { display: none; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; background: var(--panel); }
  .lcard.shown { display: block; }
  .lcard h3 { margin: 0 0 8px; font-size: 13px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }
  .lcard dl { display: grid; grid-template-columns: 110px 1fr; gap: 3px 12px; margin: 0; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12px; }
  .lcard dt { color: var(--dim); }
  .lcard dd { margin: 0; word-break: break-word; }
  .legend { color: var(--dim); font-size: 11.5px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; margin: 8px 0 0; }
`;

/** Node stroke by recency — never a success/failure claim (see LineageActivity). */
function lineageColor(node: LineageNode): string {
  if (node.activity === 'active') return '#a3e635';
  if (node.activity === 'idle') return '#e0b341';
  return '#6e7681';
}

const LNODE = { w: 210, h: 68, gapX: 22, levelH: 124, top: 30, marginX: 20 };

/**
 * Characters that fit one node line at the given font size. The box is a fixed
 * 210px and the face is monospace (~0.6em per glyph), so a line longer than this
 * runs out past the border — clip it here rather than letting the SVG overflow.
 */
function fitNodeLine(text: string, fontSizePx: number): string {
  const max = Math.floor((LNODE.w - 24) / (fontSizePx * 0.62));
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Lay the graph out level by level: depth 0 on top, each level centered below it. */
function lineageLayout(lineage: SessionLineage): {
  width: number;
  height: number;
  at: Map<string, { x: number; y: number }>;
} {
  const levels = new Map<number, LineageNode[]>();
  for (const node of lineage.nodes) {
    (levels.get(node.depth) ?? levels.set(node.depth, []).get(node.depth)!).push(node);
  }
  const widest = Math.max(1, ...[...levels.values()].map((l) => l.length));
  const width = Math.max(920, LNODE.marginX * 2 + widest * LNODE.w + (widest - 1) * LNODE.gapX);
  const depth = Math.max(...lineage.nodes.map((n) => n.depth));
  const height = LNODE.top + (depth + 1) * LNODE.levelH;

  const at = new Map<string, { x: number; y: number }>();
  for (const [level, row] of levels) {
    const rowWidth = row.length * LNODE.w + (row.length - 1) * LNODE.gapX;
    const startX = (width - rowWidth) / 2;
    row.forEach((node, i) => {
      at.set(node.id, { x: startX + i * (LNODE.w + LNODE.gapX), y: LNODE.top + level * LNODE.levelH });
    });
  }
  return { width, height, at };
}

/** The inline-SVG delegation graph: one box per session, edges parent → child. */
function renderLineageSvg(lineage: SessionLineage): string {
  const { width, height, at } = lineageLayout(lineage);
  const byId = new Map(lineage.nodes.map((n) => [n.id, n]));
  const parts: string[] = [];

  parts.push('<defs><marker id="lg" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#4a6b3a"/></marker></defs>');

  for (const edge of lineage.edges) {
    const from = at.get(edge.parent);
    const to = at.get(edge.child);
    if (!from || !to) continue;
    const x1 = from.x + LNODE.w / 2;
    const y1 = from.y + LNODE.h;
    const x2 = to.x + LNODE.w / 2;
    const y2 = to.y - 8;
    const mid = (y1 + y2) / 2;
    parts.push(`<path d="M${x1.toFixed(1)} ${y1} C ${x1.toFixed(1)} ${mid.toFixed(1)}, ${x2.toFixed(1)} ${mid.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" class="ledge" marker-end="url(#lg)"><title>${escapeHtml(edge.source)}</title></path>`);
  }

  for (const node of byId.values()) {
    const pos = at.get(node.id)!;
    const color = lineageColor(node);
    const name = node.handle && node.handle !== node.shortId ? `${node.handle} · ${node.shortId}` : node.shortId;
    // Three lines, because one 210px row cannot hold a handle, an id, a harness,
    // a role, a PR, and the counts without clipping the end off every node.
    const who = [node.agent, node.role];
    if (node.prNumber) who.push(`PR #${node.prNumber}`);
    const counts = [`${node.toolCount} tools`];
    if (node.durationMs > 0) counts.push(formatDuration(node.durationMs));
    counts.push(node.activity);
    parts.push(
      `<g class="lnode" data-id="${escapeHtml(node.id)}" tabindex="0">` +
      `<rect x="${pos.x.toFixed(1)}" y="${pos.y}" width="${LNODE.w}" height="${LNODE.h}" rx="8" stroke="${color}"><title>${escapeHtml(`${name} · ${who.join(' · ')} · ${counts.join(' · ')}`)}</title></rect>` +
      `<text x="${(pos.x + 12).toFixed(1)}" y="${pos.y + 22}" class="n-id" fill="${color}">${escapeHtml(fitNodeLine(name, 11))}</text>` +
      `<text x="${(pos.x + 12).toFixed(1)}" y="${pos.y + 40}" class="n-sub">${escapeHtml(fitNodeLine(who.join(' · '), 9))}</text>` +
      `<text x="${(pos.x + 12).toFixed(1)}" y="${pos.y + 56}" class="n-sub">${escapeHtml(fitNodeLine(counts.join(' · '), 9))}</text>` +
      '</g>',
    );
  }

  // Scale to the container and no further: a wide fan-out shrinks to fit rather
  // than pushing the page into a horizontal scroll, and a narrow one is not blown up.
  return `<div class="lineage-wrap"><svg viewBox="0 0 ${width} ${height}" style="width:100%;max-width:${width}px;height:auto" role="img" aria-label="Session lineage graph">${parts.join('')}</svg></div>`;
}

/** One detail card per node, revealed by clicking that node. */
function renderLineageCards(lineage: SessionLineage): string {
  return lineage.nodes
    .map((node) => {
      const s = node.session;
      const rows: Array<[string, string]> = [
        ['session', node.id],
        ['agent', node.agent],
        ['role', node.role],
        ['tools', String(node.toolCount)],
      ];
      if (node.durationMs > 0) rows.push(['span', formatDuration(node.durationMs)]);
      rows.push(['activity', node.activity]);
      if (node.team) rows.push(['team', node.team]);
      if (node.mode) rows.push(['mode', node.mode]);
      if (node.prNumber) rows.push(['pr', `#${node.prNumber}`]);
      if (s.project) rows.push(['project', s.project]);
      if (s.gitBranch) rows.push(['branch', s.gitBranch]);
      if (s.ticketId) rows.push(['ticket', s.ticketId]);
      if (s.outputTokens) rows.push(['out tokens', formatTokenCount(s.outputTokens)]);
      const date = (s.timestamp || '').slice(0, 10);
      if (date) rows.push(['started', date]);
      const dl = rows
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
        .join('\n        ');
      const heading = node.handle && node.handle !== node.shortId ? `${node.handle} · ${node.shortId}` : node.shortId;
      return `<div class="lcard${node.depth === 0 ? ' shown' : ''}" id="lcard-${escapeHtml(node.id)}">
      <h3>${escapeHtml(heading)}</h3>
      <dl>
        ${dl}
      </dl>
      <p class="muted" style="margin:8px 0 0;font-size:11.5px">Full trajectory: <code>agents sessions trace ${escapeHtml(node.shortId)}</code></p>
    </div>`;
    })
    .join('\n    ');
}

/** Wire node clicks to their cards. Self-contained, no CDN, no framework. */
const LINEAGE_SCRIPT = `
  (function () {
    var nodes = document.querySelectorAll('.lnode');
    function select(id) {
      document.querySelectorAll('.lcard').forEach(function (c) { c.classList.remove('shown'); });
      var card = document.getElementById('lcard-' + id);
      if (card) card.classList.add('shown');
      nodes.forEach(function (n) { n.classList.toggle('selected', n.getAttribute('data-id') === id); });
    }
    nodes.forEach(function (n) {
      var id = n.getAttribute('data-id');
      n.addEventListener('click', function () { select(id); });
      n.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); } });
    });
    if (nodes.length) select(nodes[0].getAttribute('data-id'));
  })();
`;

/**
 * Render a {@link SessionLineage} as ONE self-contained HTML page: the inline-SVG
 * delegation graph (orchestrator on top, the sessions it spawned below, edges
 * auto-discovered from the team records) plus a per-node summary card revealed
 * by clicking a node. Same shell, redaction, and no-CDN rule as the other two
 * layouts; local paths (`filePath`/`cwd`) are deliberately never rendered.
 */
export function renderLineageHtml(lineage: SessionLineage): string {
  const root = lineage.nodes[0];
  const title = root ? `${root.agent} · ${root.shortId}` : 'lineage';
  const spawned = Math.max(0, lineage.nodes.length - 1);
  const teamPart = lineage.teams.length > 0 ? ` · team ${lineage.teams.join(', ')}` : '';
  const empty = !root
    ? '<p class="muted">No lineage — the selected session spawned nothing that is indexed.</p>'
    : spawned === 0
      ? '<p class="muted">This session spawned no indexed teammate. Only the orchestrator is drawn.</p>'
      : '';
  const unresolved = lineage.unresolvedParentIds.length > 0
    ? `<p class="stall">${lineage.unresolvedParentIds.length} parent session${lineage.unresolvedParentIds.length === 1 ? '' : 's'} referenced but not in the scanned pool — widen with --limit or --since.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} — lineage</title>
<style>${BASE_STYLE}${LINEAGE_STYLE}</style>
</head>
<body>
<header>
  <div class="inner">
    <button class="toggle" id="theme" title="Toggle light and dark">&#9689;</button>
    <div class="mark">agents session trace · lineage</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="metrics">${escapeHtml(`${spawned} spawned session${spawned === 1 ? '' : 's'}${teamPart}`)}</div>
  </div>
</header>
<main>
  <h2>Lineage</h2>
  ${empty}
  ${unresolved}
  ${root ? renderLineageSvg(lineage) : ''}
  <p class="legend">node color = recency (lime active · amber idle · grey stale) · click a node for its summary · edges from teamOrigin.parentSessionId</p>
  <h2>Session</h2>
  <div class="lcards">
    ${root ? renderLineageCards(lineage) : ''}
  </div>
</main>
<footer>
  Secret-redacted lineage rendered by agents-cli &middot; <code>agents sessions trace --tree</code>
</footer>
<script>${THEME_SCRIPT}</script>
<script>${LINEAGE_SCRIPT}</script>
</body>
</html>
`;
}
