import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

// RUSH-2471: a version pointer (global/isolated default, or the `~/.<agent>`
// config symlink) left aimed at a version whose binary is gone. `agents use
// grok@1.0.0` sets BOTH the global default and the symlink; once 1.0.0's binary
// vanishes (grok self-updated it out from under the old dir) both dangle, so
// `agents sync grok` resolves the dead default and fails `not installed` even
// after the symlink is repointed. healDanglingVersionPointers heals every
// pointer off the dead version. Real fs, no mocking (repo convention): each case
// builds a real version-home layout under an isolated HOME and runs in a
// subprocess so state.ts derives ~/.agents inside the temp dir.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-pointers-test-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Run `body` under an isolated HOME. grok is an install-script agent:
 * isVersionInstalled probes getBinaryPath, which for grok resolves
 * `<versionHome>/.grok/downloads/grok-<version>` — so a version is "installed"
 * iff that file exists, and a "home-only leftover" is a version dir with the
 * config home but no downloads binary.
 */
function runInHome(body: string): Record<string, unknown> {
  const script = String.raw`
    import * as fs from 'fs';
    import * as path from 'path';
    import {
      healDanglingVersionPointers,
      setGlobalDefault,
      getGlobalDefault,
      setIsolatedDefault,
      resolveVersion,
      isVersionInstalled,
    } from './src/lib/versions.ts';
    const home = process.env.HOME;
    const versionsRoot = path.join(home, '.agents', '.history', 'versions');

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
    // Mark an installed version as an isolated install (agents add --isolated):
    // a .isolated marker at the version dir, which isVersionIsolated checks.
    function isolateGrok(version) {
      fs.writeFileSync(path.join(versionsRoot, 'grok', version, '.isolated'), '');
    }
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
  // ~/.agents from HOME while getAgentConfigPath honors AGENTS_REAL_HOME.
  const out = execFileSync('bun', ['--eval', script], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home },
    encoding: 'utf-8',
  });
  const lines = out.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

describe('healDanglingVersionPointers (RUSH-2471)', () => {
  it('heals a dead global default AND symlink together, so sync resolution stops returning the dead version', () => {
    const res = runInHome(`
      installGrok('0.2.82');
      installGrok('0.2.91');
      leftoverGrok('1.0.0');       // home-only leftover, binary gone
      // agents use grok@1.0.0 sets BOTH pointers; here 1.0.0's binary then vanished.
      setGlobalDefault('grok', '1.0.0');
      pointConfigAt('1.0.0');

      // Before the fix: only the symlink was repointed; resolveVersion still
      // returned the dead default, so bare 'agents sync grok' then failed at the
      // 'is not installed' guard.
      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({
        healed,
        symlinkNow: configSymlinkTargetVersion(),
        defaultNow: getGlobalDefault('grok'),
        resolvesTo: resolveVersion('grok', process.cwd()),
        resolvesToInstalled: isVersionInstalled('grok', resolveVersion('grok', process.cwd())),
      }));
    `);
    expect(res.healed).toEqual({
      globalDefault: { from: '1.0.0', to: '0.2.91' },
      configSymlink: { from: '1.0.0', to: '0.2.91' },
    });
    expect(res.symlinkNow).toBe('0.2.91');
    expect(res.defaultNow).toBe('0.2.91');
    // The load-bearing assertion the symlink-only fix missed: sync resolution no
    // longer lands on a dead version.
    expect(res.resolvesTo).toBe('0.2.91');
    expect(res.resolvesToInstalled).toBe(true);
  });

  it('repoints a dangling symlink to the newest installed version when there is no global default', () => {
    const res = runInHome(`
      installGrok('0.2.82');
      installGrok('0.2.91');
      leftoverGrok('1.0.0');
      pointConfigAt('1.0.0');      // symlink dangles, but no default is pinned

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({ healed, symlinkNow: configSymlinkTargetVersion() }));
    `);
    expect(res.healed).toEqual({ configSymlink: { from: '1.0.0', to: '0.2.91' } });
    expect(res.symlinkNow).toBe('0.2.91');
  });

  it('never repoints the real symlink at an isolated version (resolveVersion isolated fallback)', () => {
    const res = runInHome(`
      installGrok('0.2.91');                    // non-isolated
      installGrok('0.3.0'); isolateGrok('0.3.0'); // isolated install
      setIsolatedDefault('grok', '0.3.0');      // no global default -> resolveVersion falls back to this
      leftoverGrok('1.0.0');
      pointConfigAt('1.0.0');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({ healed, symlinkNow: configSymlinkTargetVersion() }));
    `);
    // Must land on the non-isolated 0.2.91, NOT the isolated 0.3.0 that
    // resolveVersion's isolated fallback returns — repointing the user's real
    // ~/.<agent> at an isolated install is the anti-pattern removeVersion warns of.
    expect(res.healed).toEqual({ configSymlink: { from: '1.0.0', to: '0.2.91' } });
    expect(res.symlinkNow).toBe('0.2.91');
  });

  it('does not crash (or repoint at an isolated install) when no non-isolated version survives', () => {
    const res = runInHome(`
      installGrok('0.3.0'); isolateGrok('0.3.0');  // the only install, isolated
      setGlobalDefault('grok', '1.0.0');           // dead non-isolated default (binary gone)
      leftoverGrok('1.0.0');
      pointConfigAt('1.0.0');                       // dangling symlink, no non-isolated survivor

      let error = null, healed = null, symlinkNow = null;
      try {
        healed = await healDanglingVersionPointers('grok', process.cwd());
        symlinkNow = configSymlinkTargetVersion();
      } catch (e) { error = String((e && e.message) || e); }
      console.log(JSON.stringify({ error, healed, symlinkNow }));
    `);
    // switchConfigSymlink(agent, undefined) used to throw here. The heal must
    // skip the symlink (no safe non-isolated target) rather than crash or point
    // the real config at the isolated install; the dead default still clears.
    expect(res.error).toBeNull();
    expect(res.healed).toEqual({ globalDefault: { from: '1.0.0', to: null } });
    expect(res.symlinkNow).toBe('1.0.0');
  });

  it('leaves installed pointers untouched (a deliberate agents-use choice)', () => {
    const res = runInHome(`
      installGrok('0.2.82');
      installGrok('0.2.91');
      setGlobalDefault('grok', '0.2.82');
      pointConfigAt('0.2.82');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({ healed, symlinkNow: configSymlinkTargetVersion(), defaultNow: getGlobalDefault('grok') }));
    `);
    expect(res.healed).toEqual({});
    expect(res.symlinkNow).toBe('0.2.82');
    expect(res.defaultNow).toBe('0.2.82');
  });

  it('does not adopt a real (non-symlink) config directory', () => {
    const res = runInHome(`
      installGrok('0.2.91');
      fs.mkdirSync(path.join(home, '.grok'), { recursive: true });  // real user dir, not ours
      fs.writeFileSync(path.join(home, '.grok', 'user-file'), 'keep me');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      const stat = fs.lstatSync(path.join(home, '.grok'));
      console.log(JSON.stringify({
        healed,
        isSymlink: stat.isSymbolicLink(),
        userFileKept: fs.existsSync(path.join(home, '.grok', 'user-file')),
      }));
    `);
    expect(res.healed).toEqual({});
    expect(res.isSymlink).toBe(false);
    expect(res.userFileKept).toBe(true);
  });
});
