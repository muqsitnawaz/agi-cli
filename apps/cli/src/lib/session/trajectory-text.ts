/**
 * Render a {@link SessionTrajectory} as a compact, ANSI-free, token-bounded text
 * trajectory — the rendering an AGENT reads in-context when it asks "where did
 * session X stall?" (the non-TTY / `--text` audience of `agents sessions trace`).
 *
 * Deliberately terse: a header line, the idle stalls, one line per step (tool,
 * redacted label, duration, outcome), a "where the time went" line, and a bounded
 * error-detail tail. No color, no box-drawing, no cursor codes — safe to splice
 * straight into another agent's prompt. `errorsOnly` collapses the run to the
 * error steps and their neighbours so a triaging agent pays only for the failures.
 */
import { formatTokenCount } from './render.js';
import type { SessionTrajectory, TrajectoryStep } from './trajectory.js';
import type { TrajectoryComparison, TrajectorySummary } from './trajectory-compare.js';
import type { SessionLineage } from './trajectory-lineage.js';
import type { SessionMeta } from './types.js';

export interface RenderTrajectoryTextOptions {
  /** Collapse to error steps and their immediate neighbours. */
  errorsOnly?: boolean;
  /** Cap on the step lines emitted; the remainder is collapsed with a count. */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 80;
const LABEL_COL = 40;

/** Precise, compact per-step duration: "8m04s", "1.6s", "320ms", "—" for zero. */
function dur(ms: number, estimated: boolean): string {
  if (ms <= 0) return estimated ? '~0s' : '0s';
  let s: string;
  if (ms < 1000) s = `${Math.round(ms)}ms`;
  else if (ms < 60_000) s = `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  else {
    const totalSec = Math.round(ms / 1000);
    s = `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, '0')}s`;
  }
  return estimated ? `~${s}` : s;
}

function outcomeMark(step: TrajectoryStep): string {
  if (step.outcome === 'error') {
    return typeof step.exitCode === 'number' ? `exit ${step.exitCode} ✗` : '✗';
  }
  if (step.outcome === 'ok') return 'ok';
  return '';
}

/** The label a row leads with — the effective shell program for a Bash-family step, else the tool/kind. */
function stepBadgeLabel(step: TrajectoryStep): string {
  return step.program ?? step.tool ?? step.kind;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function clipLabel(label: string): string {
  const oneLine = label.replace(/\s+/g, ' ').trim();
  return oneLine.length <= LABEL_COL ? oneLine : `${oneLine.slice(0, LABEL_COL - 1)}…`;
}

function shareLine(model: SessionTrajectory): string | undefined {
  const entries = Object.entries(model.toolTimeShare)
    .sort((a, b) => b[1] - a[1])
    .filter(([, share]) => share >= 0.02)
    .slice(0, 5)
    .map(([tool, share]) => `${tool} ${Math.round(share * 100)}%`);
  return entries.length > 0 ? `where the time went: ${entries.join('  ')}` : undefined;
}

/** Tool mix broken down by EFFECTIVE PROGRAM for a shell step, never lumped as "Bash". */
function toolMixLine(model: SessionTrajectory): string | undefined {
  const counts = new Map<string, number>();
  for (const step of model.steps) {
    if (step.kind !== 'tool') continue;
    const label = stepBadgeLabel(step);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return entries.length > 0 ? `tool mix: ${entries.map(([tool, count]) => `${tool} ${count}`).join('  ')}` : undefined;
}

/** One-line analysis summary: error count, idle total, longest gap. */
function analysisLine(model: SessionTrajectory): string | undefined {
  const idleTotal = model.gaps.reduce((n, g) => n + g.durationMs, 0);
  const longestGap = model.gaps.reduce((m, g) => Math.max(m, g.durationMs), 0);
  const bits: string[] = [];
  if (model.errorCount > 0) bits.push(`${model.errorCount} error${model.errorCount === 1 ? '' : 's'}`);
  if (idleTotal > 0) bits.push(`idle ${dur(idleTotal, false)} total`);
  if (longestGap > 0) bits.push(`longest gap ${dur(longestGap, false)}`);
  return bits.length > 0 ? `analysis: ${bits.join(' · ')}` : undefined;
}

/** Select the steps to print: all of them, or (errorsOnly) errors + neighbours. */
function selectSteps(steps: TrajectoryStep[], errorsOnly: boolean): Array<TrajectoryStep | 'gap'> {
  if (!errorsOnly) return steps;
  const keep = new Set<number>();
  steps.forEach((step, i) => {
    if (step.outcome === 'error') {
      keep.add(i);
      if (i > 0) keep.add(i - 1);
      if (i < steps.length - 1) keep.add(i + 1);
    }
  });
  const out: Array<TrajectoryStep | 'gap'> = [];
  let prevKept = -1;
  const firstKept = steps.findIndex((_, i) => keep.has(i));
  if (firstKept > 0) out.push('gap'); // steps dropped before the first error neighbourhood
  steps.forEach((step, i) => {
    if (!keep.has(i)) return;
    if (prevKept >= 0 && i - prevKept > 1) out.push('gap');
    out.push(step);
    prevKept = i;
  });
  if (prevKept >= 0 && prevKept < steps.length - 1) out.push('gap'); // steps dropped after the last
  return out;
}

/** Render one session's trajectory as compact, ANSI-free text. */
export function renderTrajectoryText(
  model: SessionTrajectory,
  options: RenderTrajectoryTextOptions = {},
): string {
  const { session, stats } = model;
  const errorsOnly = options.errorsOnly === true;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const lines: string[] = [];

  // Header.
  const spanMin = model.spanMs > 0 ? `${Math.max(1, Math.round(model.spanMs / 60_000))}m` : '0m';
  const errPart = model.errorCount > 0 ? ` · ${model.errorCount}✗` : '';
  const tokPart = stats.outputTokens > 0 ? ` · ${formatTokenCount(stats.outputTokens)} out` : '';
  const modelPart = session.model ? `·${session.model}` : '';
  lines.push(`${session.shortId || session.id} ${session.agent}${modelPart} · ${spanMin} · ${stats.toolCount} tools${errPart}${tokPart}`);

  if (model.steps.length === 0) {
    lines.push('(no events to visualize)');
    return lines.join('\n') + '\n';
  }

  // Analysis summary — errors, idle total, longest gap.
  const analysis = analysisLine(model);
  if (analysis) lines.push(analysis);

  const stepLine = (step: TrajectoryStep): string => {
    const ord = pad(String(step.ordinal).padStart(2, '0'), 3);
    const tool = pad(stepBadgeLabel(step), 6);
    const label = pad(clipLabel(step.label), LABEL_COL);
    const mark = outcomeMark(step);
    return `${ord} ${tool} ${label} ${dur(step.durationMs, step.durationEstimated)}${mark ? ' ' + mark : ''}`.trimEnd();
  };

  let omitted = 0;
  if (errorsOnly) {
    // Collapsed to error steps and their neighbours — omitted ranges shown as '  …'.
    const selected = selectSteps(model.steps, true);
    let printed = 0;
    for (const entry of selected) {
      if (entry === 'gap') { lines.push('  …'); continue; }
      if (printed >= maxSteps) { omitted++; continue; }
      lines.push(stepLine(entry));
      if (entry.outcome === 'error' && entry.detail) lines.push(`     ${clipLabel(entry.detail)}`);
      printed++;
    }
  } else {
    // Full run, step-ordered, with idle gaps rendered as dividers between the
    // steps they actually fall between — never a wall-clock axis.
    const gapsSorted = [...model.gaps].sort((a, b) => a.startMs - b.startMs);
    let gapIdx = 0;
    // A gap may fall BEFORE the first step (`afterOrdinal: 0`), so start
    // `prevMs` at the session origin, not `null` — else a leading stall is
    // silently dropped.
    let prevMs = 0;
    let printed = 0;
    const emitGapsBefore = (curMs: number): void => {
      while (gapIdx < gapsSorted.length && gapsSorted[gapIdx].startMs >= prevMs && gapsSorted[gapIdx].startMs < curMs) {
        lines.push(`  ···  idle ${dur(gapsSorted[gapIdx].durationMs, false)}  ···`);
        gapIdx++;
      }
    };
    for (const step of model.steps) {
      emitGapsBefore(step.startMs);
      if (printed >= maxSteps) { omitted++; prevMs = step.startMs; continue; }
      lines.push(stepLine(step));
      if (step.outcome === 'error' && step.detail) lines.push(`     ${clipLabel(step.detail)}`);
      printed++;
      prevMs = step.startMs;
    }
    emitGapsBefore(Number.POSITIVE_INFINITY);
  }
  if (omitted > 0) lines.push(`  … ${omitted} more step${omitted === 1 ? '' : 's'} (raise --json for the full model)`);
  if (model.truncatedSteps > 0) lines.push(`  … ${model.truncatedSteps} step${model.truncatedSteps === 1 ? '' : 's'} collapsed by the render cap`);

  // Where the time went / tool mix.
  const share = shareLine(model);
  if (share) lines.push(share);
  const mix = toolMixLine(model);
  if (mix) lines.push(mix);

  return lines.join('\n') + '\n';
}

export interface RenderTrajectoryCompareTextOptions {
  /** Cap on step lines listed per diff column; the remainder is collapsed with a count. Default 15. */
  maxDiffLines?: number;
}

const DEFAULT_MAX_DIFF_LINES = 15;

function sessionLabel(session: SessionMeta): string {
  return `${session.agent} ${session.shortId || session.id}`;
}

function summaryLine(summary: TrajectorySummary): string {
  const spanMin = summary.spanMs > 0 ? `${Math.max(1, Math.round(summary.spanMs / 60_000))}m` : '0m';
  const errPart = summary.errorCount > 0 ? ` · ${summary.errorCount}✗` : '';
  const tokPart = summary.outputTokens > 0 ? ` · ${formatTokenCount(summary.outputTokens)} out` : '';
  return `  ${sessionLabel(summary.session)} · ${spanMin} · ${summary.toolCount} tools${errPart}${tokPart}`;
}

function diffColumn(heading: string, steps: TrajectoryStep[], maxLines: number): string[] {
  if (steps.length === 0) return [`${heading} (0): none`];
  const lines = [`${heading} (${steps.length}):`];
  const shown = steps.slice(0, maxLines);
  for (const step of shown) {
    const mark = outcomeMark(step);
    lines.push(`  ${pad(stepBadgeLabel(step), 6)} ${pad(clipLabel(step.label), LABEL_COL)} ${dur(step.durationMs, step.durationEstimated)}${mark ? ' ' + mark : ''}`.trimEnd());
  }
  const omitted = steps.length - shown.length;
  if (omitted > 0) lines.push(`  … ${omitted} more`);
  return lines;
}

/**
 * Render a two-session {@link TrajectoryComparison} as compact, ANSI-free text —
 * both sessions' headline stats, the first divergence point, and the step-level
 * diff (only-in-first / only-in-second), each capped so a triaging agent pays a
 * bounded token cost regardless of how far the two runs diverge.
 */
export function renderTrajectoryCompareText(
  cmp: TrajectoryComparison,
  options: RenderTrajectoryCompareTextOptions = {},
): string {
  const maxDiffLines = options.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
  const labelA = sessionLabel(cmp.a.session);
  const labelB = sessionLabel(cmp.b.session);
  const lines: string[] = [];

  lines.push(`compare: ${labelA} vs ${labelB}`);
  lines.push(summaryLine(cmp.summaryA));
  lines.push(summaryLine(cmp.summaryB));

  if (cmp.divergence) {
    lines.push(`diverge after step ${cmp.divergence.afterOrdinalA}/${cmp.divergence.afterOrdinalB}: ${cmp.divergence.detail}`);
  } else {
    lines.push('no divergence — tool sequences match');
  }

  if (cmp.truncatedA > 0 || cmp.truncatedB > 0) {
    lines.push(`diff capped — ${cmp.truncatedA} step(s) from the first and ${cmp.truncatedB} from the second were not compared`);
  }

  lines.push(...diffColumn(`only in ${labelA}`, cmp.removed, maxDiffLines));
  lines.push(...diffColumn(`only in ${labelB}`, cmp.added, maxDiffLines));

  return lines.join('\n') + '\n';
}

/**
 * Render a {@link SessionLineage} as a tree — the `--tree` text rendering an
 * agent reads when it asks "what did this orchestrator spawn, and where did the
 * fan-out go?".
 *
 * Drawn from the EDGES, not from each node's depth. Indenting by depth alone
 * puts every depth-2 node under whichever depth-1 node happened to print last,
 * so a nested teammate reads as a child of its aunt and its real parent is
 * unrecoverable from the output — a lie an agent has no way to detect.
 *
 * One line per session: its handle/short id, harness, role, indexed tool count,
 * span, recency and PR when it opened one. No per-step detail — lineage answers
 * the shape of the fan-out; `agents sessions trace <child>` answers one child.
 */
export function renderLineageText(lineage: SessionLineage): string {
  const lines: string[] = [];
  const root = lineage.nodes[0];
  if (!root) {
    lines.push('(no lineage — the selected session spawned nothing indexed)');
    return lines.join('\n') + '\n';
  }

  const teamPart = lineage.teams.length > 0 ? ` · team ${lineage.teams.map((t) => `"${t}"`).join(', ')}` : '';
  const spawned = lineage.nodes.length - 1;
  lines.push(`lineage: ${root.agent} ${root.shortId}${teamPart} · ${spawned} spawned session${spawned === 1 ? '' : 's'}`);

  const byId = new Map(lineage.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  for (const edge of lineage.edges) {
    (childrenOf.get(edge.parent) ?? childrenOf.set(edge.parent, []).get(edge.parent)!).push(edge.child);
  }

  const describe = (node: SessionLineage['nodes'][number]): string => {
    const name = node.handle && node.handle !== node.shortId ? `${node.handle} · ${node.shortId}` : node.shortId;
    const bits = [node.agent, node.role, `${node.toolCount} tools`];
    if (node.durationMs > 0) bits.push(dur(node.durationMs, false));
    bits.push(node.activity);
    if (node.mode) bits.push(node.mode);
    if (node.prNumber) bits.push(`PR #${node.prNumber}`);
    return `${name} · ${bits.join(' · ')}`;
  };

  // Depth-first from the root so a child always prints directly under its own
  // parent; `prefix` carries the ancestors' continuation bars.
  const walk = (id: string, prefix: string): void => {
    const kids = childrenOf.get(id) ?? [];
    kids.forEach((childId, i) => {
      const node = byId.get(childId);
      if (!node) return;
      const last = i === kids.length - 1;
      lines.push(`${prefix}${last ? '└─ ' : '├─ '}${describe(node)}`);
      walk(childId, `${prefix}${last ? '   ' : '│  '}`);
    });
  };

  lines.push(describe(root));
  walk(root.id, '');

  if (lineage.unresolvedParentIds.length > 0) {
    lines.push(
      `unresolved parent${lineage.unresolvedParentIds.length === 1 ? '' : 's'} (not in the scanned pool): ` +
      lineage.unresolvedParentIds.join(', '),
    );
  }

  return lines.join('\n') + '\n';
}
