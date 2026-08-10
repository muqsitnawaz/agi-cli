import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// These drive the REAL release scripts, not a reimplementation of their parsing.
// Every case here exits before the first mutation (no worktree, no fetch, no
// network), which is what makes it safe to run the actual release entrypoint in
// a unit test: --help returns immediately, and every other case dies in argument
// validation.
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const RELEASE = join(SCRIPTS_DIR, 'release.sh');
const RELEASE_WORKTREE = join(SCRIPTS_DIR, 'release-worktree.sh');

function runScript(script: string, args: string[]) {
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    // A bare temp cwd: none of these cases should reach a git operation, so if
    // one ever does it fails loudly here instead of touching the real checkout.
    cwd: mkdtempSync(join(tmpdir(), 'release-args-')),
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('release.sh argument parsing', () => {
  it('advertises --home-base in usage', () => {
    const { status, out } = runScript(RELEASE, ['--help']);
    expect(status).toBe(0);
    expect(out).toContain('--home-base <host>');
  });

  it('rejects --home-base with no host', () => {
    const { status, out } = runScript(RELEASE, ['1.2.3', '--home-base']);
    expect(status).not.toBe(0);
    expect(out).toContain('--home-base needs a host name');
  });

  it('rejects an empty --home-base=', () => {
    const { status, out } = runScript(RELEASE, ['1.2.3', '--home-base=']);
    expect(status).not.toBe(0);
    expect(out).toContain('--home-base needs a host name');
  });

  // The parse loop was rewritten from `for arg in "$@"` to a shifting `while`
  // so --home-base could take a value; these two pin the behavior that rewrite
  // could plausibly have broken.
  it('still rejects an unknown flag', () => {
    const { status, out } = runScript(RELEASE, ['1.2.3', '--nope']);
    expect(status).not.toBe(0);
    expect(out).toContain('unknown flag: --nope');
  });

  it('still rejects a non-semver version', () => {
    const { status, out } = runScript(RELEASE, ['v1.2', '--apply']);
    expect(status).not.toBe(0);
    expect(out).toContain('version must be MAJOR.MINOR.PATCH');
  });

  it('still requires a version', () => {
    const { status, out } = runScript(RELEASE, ['--apply']);
    expect(status).not.toBe(0);
    expect(out).toContain('usage: scripts/release.sh');
  });
});

describe('release-worktree.sh version detection', () => {
  // The regression this guards: release-worktree.sh picks the first non-flag
  // argument as the version. `--home-base zion` puts a bare, non-flag word in
  // argv, so without skipping the flag's value it names the release worktree
  // after "zion" and orchestrates a release for a nonexistent version.
  it('does not mistake the --home-base value for the version', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'release-wt-'));
    const { status, out } = runScript(RELEASE_WORKTREE, [repoRoot, '--home-base', 'zion']);
    expect(status).not.toBe(0);
    expect(out).toContain('release version is required');
    expect(out).not.toContain('zion');
  });

  it('finds the version when it follows --home-base <host>', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'release-wt-'));
    const { status, out } = runScript(RELEASE_WORKTREE, [
      repoRoot,
      '--home-base',
      'zion',
      '1.2.3',
      '--apply',
    ]);
    // It gets past version detection and dies on the temp dir not being a repo.
    expect(status).not.toBe(0);
    expect(out).not.toContain('release version is required');
  });
});
