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
  if (step.outcome === 'error') return '✗';
  if (step.outcome === 'ok') return 'ok';
  return '';
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

  // Idle stalls, most notable first.
  for (const gap of [...model.gaps].sort((a, b) => b.durationMs - a.durationMs).slice(0, 4)) {
    lines.push(`idle ${dur(gap.durationMs, false)} after step ${gap.afterOrdinal} (stall)`);
  }

  // Steps.
  const selected = selectSteps(model.steps, errorsOnly);
  let printed = 0;
  let omitted = 0;
  for (const entry of selected) {
    if (entry === 'gap') { lines.push('  …'); continue; }
    if (printed >= maxSteps) { omitted++; continue; }
    const ord = pad(String(entry.ordinal).padStart(2, '0'), 3);
    const tool = pad(entry.tool ?? entry.kind, 6);
    const label = pad(clipLabel(entry.label), LABEL_COL);
    const mark = outcomeMark(entry);
    lines.push(`${ord} ${tool} ${label} ${dur(entry.durationMs, entry.durationEstimated)}${mark ? ' ' + mark : ''}`.trimEnd());
    // A short, indented evidence line for an error step.
    if (entry.outcome === 'error' && entry.detail) {
      lines.push(`     ${clipLabel(entry.detail)}`);
    }
    printed++;
  }
  if (omitted > 0) lines.push(`  … ${omitted} more step${omitted === 1 ? '' : 's'} (raise --json for the full model)`);
  if (model.truncatedSteps > 0) lines.push(`  … ${model.truncatedSteps} step${model.truncatedSteps === 1 ? '' : 's'} collapsed by the render cap`);

  // Where the time went.
  const share = shareLine(model);
  if (share) lines.push(share);

  return lines.join('\n') + '\n';
}
