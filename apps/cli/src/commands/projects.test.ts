import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  computeProjectListWidths,
  formatFleetSkippedNote,
  formatMilestoneDue,
  formatMilestoneLines,
  formatNextMilestone,
  mergeBoundDirs,
  removeBoundDirs,
  repoForDir,
  type ProjectListRow,
} from './projects.js';
import type { ProjectRepo } from '../lib/projects.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatFleetSkippedNote', () => {
  it('says nothing when every peer answered', () => {
    expect(formatFleetSkippedNote([])).toBe('');
  });

  it('names up to four peers, collapsing the rest to +N, with honest reasons', () => {
    expect(stripAnsi(formatFleetSkippedNote(['gpu-box'])))
      .toBe("  · 1 device didn't answer (unreachable, older agents-cli, or timed out): gpu-box\n");
    expect(stripAnsi(formatFleetSkippedNote(['a', 'b', 'c', 'd', 'e', 'f'])))
      .toBe("  · 6 devices didn't answer (unreachable, older agents-cli, or timed out): a, b, c, d +2\n");
  });
});

describe('computeProjectListWidths', () => {
  /** Render a row the way `list` does, so a bleeding column shows up as a shifted gridline. */
  const render = (r: ProjectListRow, w: { name: number; path: number; repo: number }) =>
    `  ${r.name.padEnd(w.name)} ${r.path.padEnd(w.path)} ${r.repo.padEnd(w.repo)} 0 agents`;

  it('sizes every column to the widest row instead of a fixed 32', () => {
    const rows: ProjectListRow[] = [
      { name: 'agents', path: '~/src/github.com/muqsitnawaz/agents', repo: 'muqsitnawaz/agents' },
      { name: 'agents-cli', path: '~/src/github.com/muqsitnawaz/agents-cli', repo: 'muqsitnawaz/agents-cli' },
    ];
    const w = computeProjectListWidths(rows);
    expect(w).toEqual({ name: 10, path: 39, repo: 22 });
    // The repo column starts at the same offset on every row — the bug was a
    // 32-char pad that a ~39-char home-relative path ran straight through.
    const offsets = rows.map((r) => render(r, w).indexOf(r.repo));
    expect(new Set(offsets).size).toBe(1);
  });

  it('caps the path column so one long root cannot widen the whole table', () => {
    const w = computeProjectListWidths([
      { name: 'a', path: '~/' + 'x'.repeat(120), repo: 'o/r' },
      { name: 'b', path: '~/short', repo: 'o/r2' },
    ]);
    expect(w.path).toBe(48);
  });

  it('collapses to zero-width columns when there is nothing to show', () => {
    expect(computeProjectListWidths([])).toEqual({ name: 0, path: 0, repo: 0 });
    expect(computeProjectListWidths([{ name: 'a', path: '', repo: '' }])).toEqual({ name: 1, path: 0, repo: 0 });
  });
});

describe('formatMilestoneDue', () => {
  /** Local noon on 2026-08-03, so a timezone slip shows up as a whole-day error. */
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();

  it('speaks in days a person would use', () => {
    expect(formatMilestoneDue('2026-08-03', now)).toBe('due today');
    expect(formatMilestoneDue('2026-08-04', now)).toBe('due tomorrow');
    expect(formatMilestoneDue('2026-08-09', now)).toBe('due in 6 days');
    expect(formatMilestoneDue('2026-08-02', now)).toBe('overdue by a day');
    expect(formatMilestoneDue('2026-07-27', now)).toBe('overdue by 7 days');
  });

  it('switches to a calendar date once the countdown stops being useful', () => {
    expect(formatMilestoneDue('2026-08-21', now)).toBe('due Aug 21');
    // A different year has to say which one.
    expect(formatMilestoneDue('2027-01-15', now)).toBe('due Jan 15, 2027');
  });

  it('reads the date at LOCAL midnight, not UTC', () => {
    // `new Date('2026-08-03')` is UTC midnight — west of Greenwich that is
    // Aug 2 locally, and this would read "overdue by a day" instead of "today".
    expect(formatMilestoneDue('2026-08-03', new Date(2026, 7, 3, 23, 59).getTime())).toBe('due today');
    expect(formatMilestoneDue('2026-08-03', new Date(2026, 7, 3, 0, 1).getTime())).toBe('due today');
  });

  it('returns nothing for a value that is not a calendar date', () => {
    expect(formatMilestoneDue('', now)).toBeUndefined();
    expect(formatMilestoneDue('someday', now)).toBeUndefined();
    expect(formatMilestoneDue('2026-08-03T00:00:00Z', now)).toBeUndefined();
  });
});

describe('formatNextMilestone', () => {
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();

  it('reads name, progress, then when it is due', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Beta cut', targetDate: '2026-08-09', done: 3, total: 8 }, now)))
      .toBe('Beta cut  ·  3/8  ·  due in 6 days');
  });

  it('omits the date entirely when the milestone has none', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Someday', done: 0, total: 4 }, now)))
      .toBe('Someday  ·  0/4');
  });

  it('omits the fraction when nothing is filed under the milestone yet', () => {
    // 0/0 is noise. This is the real shape of every milestone in this repo's
    // own Linear project.
    expect(stripAnsi(formatNextMilestone({ name: 'Factory onboarding', targetDate: '2026-09-15', done: 0, total: 0 }, now)))
      .toBe('Factory onboarding  ·  due Sep 15');
  });

  it('does not print a raw date when the stored value is unparseable', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Odd', targetDate: 'not-a-date', done: 1, total: 2 }, now)))
      .toBe('Odd  ·  1/2');
  });
});

describe('formatMilestoneLines', () => {
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();
  const ms = [
    { name: 'Factory converts strategy', targetDate: '2026-09-15', done: 0, total: 0 },
    { name: 'Factory reliability', targetDate: '2026-09-30', done: 0, total: 0 },
    { name: 'Factory onboarding', targetDate: '2026-10-15', done: 0, total: 0 },
  ];

  it('shows one line plus a pointer on the compact card', () => {
    const out = formatMilestoneLines(ms, ms[0], now, 1).map(stripAnsi);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Factory converts strategy');
    expect(out[1]).toContain('+2 more milestones');
    expect(out[1]).toContain('agents projects view');
  });

  it('shows every milestone when the limit allows, with no pointer', () => {
    const out = formatMilestoneLines(ms, ms[0], now, 99).map(stripAnsi);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('Factory onboarding');
    expect(out.join('\n')).not.toContain('more milestone');
  });

  it('labels the first row `plan` when there is no next at all', () => {
    const out = formatMilestoneLines(ms, undefined, now, 1).map(stripAnsi);
    expect(out[0].trimStart().startsWith('plan')).toBe(true);
  });

  it('leads with the NEXT milestone even when a different one is dated earlier', () => {
    // Linear can flag a later milestone as next. Slicing the date-ordered front
    // would show the earlier one and bury the actual next under "+N more".
    const out = formatMilestoneLines(ms, ms[2], now, 1).map(stripAnsi);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Factory onboarding');
    expect(out[1]).toContain('+2 more');
  });

  it('does not repeat the next milestone further down the full list', () => {
    const out = formatMilestoneLines(ms, ms[2], now, 99).map(stripAnsi);
    expect(out).toHaveLength(3);
    expect(out.filter((l) => l.includes('Factory onboarding'))).toHaveLength(1);
    expect(out[0]).toContain('Factory onboarding');
  });

  it('labels the right row when two milestones share a name', () => {
    const dup = [
      { name: 'Cut', targetDate: '2026-09-01', done: 0, total: 0 },
      { name: 'Cut', targetDate: '2026-10-01', done: 0, total: 0 },
    ];
    // Matching on name alone put the label on the Sep row.
    const out = formatMilestoneLines(dup, dup[1], now, 99).map(stripAnsi);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Oct 1');
    expect(out[1]).not.toContain('next');
  });

  it('renders nothing when the project declares no milestones', () => {
    expect(formatMilestoneLines([], undefined, now, 1)).toEqual([]);
  });

  it('still renders a next carried alone by an older cached answer', () => {
    // A cache entry written before `milestones` existed has only `nextMilestone`.
    const out = formatMilestoneLines([], ms[0], now, 1).map(stripAnsi);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Factory converts strategy');
  });
});

describe('mergeBoundDirs / removeBoundDirs (set --add-dir/--rm-dir)', () => {
  it('preserves a same-path binding under a different subpath — no silent collapse', () => {
    // Two distinct bindings of one checkout (a monorepo binding apps/web AND
    // apps/api). An unrelated --add-dir must not drop either — the old
    // path-only key collapsed them, losing a binding on disk.
    const existing: ProjectRepo[] = [
      { slug: 'o/mono', path: '~/src/mono', subpath: 'apps/web' },
      { slug: 'o/mono', path: '~/src/mono', subpath: 'apps/api' },
    ];
    expect(mergeBoundDirs(existing, [{ slug: 'o/infra', path: '~/src/infra' }])).toEqual([
      { slug: 'o/mono', path: '~/src/mono', subpath: 'apps/web' },
      { slug: 'o/mono', path: '~/src/mono', subpath: 'apps/api' },
      { slug: 'o/infra', path: '~/src/infra' },
    ]);
  });

  it('refreshes an exact (path, subpath) match in place, and appends a genuinely new one', () => {
    expect(
      mergeBoundDirs([{ slug: 'old/x', path: '~/src/x' }], [{ slug: 'new/x', path: '~/src/x' }]),
    ).toEqual([{ slug: 'new/x', path: '~/src/x' }]);
    // Absolute-under-home and home-relative forms of the same dir are one key.
    const abs = path.join(os.homedir(), 'src', 'x');
    expect(
      mergeBoundDirs([{ slug: 'old/x', path: '~/src/x' }], [{ slug: 'new/x', path: abs }]),
    ).toEqual([{ slug: 'new/x', path: abs }]);
  });

  it('removeBoundDirs drops every binding under a path, any subpath', () => {
    expect(
      removeBoundDirs(
        [
          { slug: 'o/mono', path: '~/src/mono', subpath: 'apps/web' },
          { slug: 'o/mono', path: '~/src/mono', subpath: 'apps/api' },
          { slug: 'o/infra', path: '~/src/infra' },
        ],
        ['~/src/mono'],
      ),
    ).toEqual([{ slug: 'o/infra', path: '~/src/infra' }]);
  });
});

describe('repoForDir origin diagnosis', () => {
  it('diagnoses a git repo whose origin is not a GitHub owner/repo precisely', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-nongh-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: d });
      execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/o/r.git'], { cwd: d });
      // It IS a git repo with an origin — the message must not claim otherwise.
      expect(() => repoForDir(d)).toThrow(/not a GitHub owner\/repo/);
      expect(() => repoForDir(d)).not.toThrow(/not a git repo/);
      // --slug override still resolves it.
      expect(repoForDir(d, 'o/r')).toEqual({ slug: 'o/r', path: path.resolve(d) });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
