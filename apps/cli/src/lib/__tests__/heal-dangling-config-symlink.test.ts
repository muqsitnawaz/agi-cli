import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

// RUSH-2471: `~/.<agent>` on yosemite-s0 symlinked into grok@1.0.0 — a version
// whose launch binary was gone (only 0.2.82 / 0.2.91 installed), so every sync
// landed in an installed version while `~/.grok` still resolved to the dead one.
// healDanglingConfigSymlink runs on the sync resolve path and repoints the
// symlink at an installed version. Real fs, no mocking (repo convention): each
// case builds a real version-home layout under an isolated HOME and calls the
// function in a subprocess so state.ts derives ~/.agents inside the temp dir.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-symlink-test-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Run `body` under an isolated HOME. `body` sets up a grok version layout with
 * the shared helpers below, then prints one JSON line the caller parses. grok is
 * an install-script agent: isVersionInstalled probes getBinaryPath, which for
 * grok resolves `<versionHome>/.grok/downloads/grok-<version>` — so a version is
 * "installed" iff that file exists, and a "home-only leftover" is a version dir
 * with the config home but no downloads binary.
 */
function runInHome(body: string): Record<string, unknown> {
  const script = String.raw`
    import * as fs from 'fs';
    import * as path from 'path';
    import { healDanglingConfigSymlink } from './src/lib/versions.ts';
    const home = process.env.HOME;
    const versionsRoot = path.join(home, '.agents', '.history', 'versions');

    // grokHome(version) -> the version's config home (~/.grok's real target).
    function grokHome(version) {
      return path.join(versionsRoot, 'grok', version, 'home', '.grok');
    }
    // Mark a grok version installed: drop the per-version launch binary where
    // getBinaryPath('grok', v) looks for it (downloads/grok-<v>).
    function installGrok(version) {
      const downloads = path.join(grokHome(version), 'downloads');
      fs.mkdirSync(downloads, { recursive: true });
      fs.writeFileSync(path.join(downloads, 'grok-' + version), 'binary');
    }
    // A home-only leftover: config home exists, no downloads binary -> NOT installed.
    function leftoverGrok(version) {
      fs.mkdirSync(grokHome(version), { recursive: true });
    }
    // Point ~/.grok at a version's config home (the adoption symlink).
    function pointConfigAt(version) {
      const link = path.join(home, '.grok');
      try { fs.unlinkSync(link); } catch {}
      fs.symlinkSync(grokHome(version), link, process.platform === 'win32' ? 'junction' : undefined);
    }
    function configSymlinkTargetVersion() {
      const link = path.join(home, '.grok');
      const target = fs.readlinkSync(link).replace(/\\/g, '/');
      const m = target.match(/versions\/grok\/([^/]+)\/home/);
      return m ? m[1] : null;
    }
    ${body}
  `;
  // Pin BOTH HOME and AGENTS_REAL_HOME (mirrors uninstall.test): state.ts derives
  // ~/.agents from HOME while getAgentConfigPath honors AGENTS_REAL_HOME; a stale
  // AGENTS_REAL_HOME leaking in from the outer env would diverge the two.
  const out = execFileSync('bun', ['--eval', script], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home },
    encoding: 'utf-8',
  });
  const lines = out.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

describe('healDanglingConfigSymlink (RUSH-2471)', () => {
  it('repoints ~/.grok from a not-installed version to the newest installed one', () => {
    const res = runInHome(`
      installGrok('0.2.82');
      installGrok('0.2.91');
      leftoverGrok('1.0.0');       // home-only leftover, binary gone
      pointConfigAt('1.0.0');      // ~/.grok -> the dead version

      const healed = await healDanglingConfigSymlink('grok', process.cwd());
      console.log(JSON.stringify({ healed, symlinkNow: configSymlinkTargetVersion() }));
    `);
    // Before the fix nothing repoints the dangling symlink, so it would still
    // resolve to 1.0.0 — the exact yosemite-s0 divergence.
    expect(res.healed).toEqual({ from: '1.0.0', to: '0.2.91' });
    expect(res.symlinkNow).toBe('0.2.91');
  });

  it('leaves a symlink already pointing at an installed version untouched', () => {
    const res = runInHome(`
      installGrok('0.2.82');
      installGrok('0.2.91');
      pointConfigAt('0.2.82');     // a deliberate 'agents use' choice

      const healed = await healDanglingConfigSymlink('grok', process.cwd());
      console.log(JSON.stringify({ healed, symlinkNow: configSymlinkTargetVersion() }));
    `);
    expect(res.healed).toBeNull();
    expect(res.symlinkNow).toBe('0.2.82');
  });

  it('does not adopt a real (non-symlink) config directory', () => {
    const res = runInHome(`
      installGrok('0.2.91');
      fs.mkdirSync(path.join(home, '.grok'), { recursive: true });  // real user dir, not ours
      fs.writeFileSync(path.join(home, '.grok', 'user-file'), 'keep me');

      const healed = await healDanglingConfigSymlink('grok', process.cwd());
      const stat = fs.lstatSync(path.join(home, '.grok'));
      console.log(JSON.stringify({
        healed,
        isSymlink: stat.isSymbolicLink(),
        userFileKept: fs.existsSync(path.join(home, '.grok', 'user-file')),
      }));
    `);
    expect(res.healed).toBeNull();
    expect(res.isSymlink).toBe(false);
    expect(res.userFileKept).toBe(true);
  });
});
