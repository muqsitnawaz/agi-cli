import { describe, expect, it } from 'vitest';
import { resolveResumePacking, resumeCwd } from './sessions-resume.js';

describe('resumeCwd — a local existsSync must not decide a remote path (RUSH-2022)', () => {
  const session = { cwd: '/srv/work/api' };

  it('takes the recorded cwd as written for a --host batch, even when absent here', () => {
    // The tab is a `tmux new-window -c <cwd>` on that device: the directory
    // lives over there, so this box's disk has no say.
    expect(resumeCwd(session, 'zion', () => false)).toBe('/srv/work/api');
  });

  it('refuses a --host session with no recorded cwd rather than sending a local path', () => {
    expect(resumeCwd({}, 'zion', () => true)).toBeUndefined();
  });

  it('still falls back to this directory for a LOCAL batch whose cwd is gone', () => {
    expect(resumeCwd(session, undefined, () => false)).toBe(process.cwd());
    expect(resumeCwd(session, undefined, () => true)).toBe('/srv/work/api');
  });
});

describe('resolveResumePacking', () => {
  it('opens every resumed session in its own tab by default', () => {
    expect(resolveResumePacking({})).toBe('tabs');
  });

  it('packs session pairs into split panes only when requested', () => {
    expect(resolveResumePacking({ splits: true })).toBe('two-per-tab');
  });
});
