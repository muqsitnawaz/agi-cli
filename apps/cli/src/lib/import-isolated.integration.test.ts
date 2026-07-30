import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `agents import` adopts: it MOVES ~/.<agent> into a version home, symlinks the
// original away, sets the global default and creates a shim. That is the opposite of
// isolation, so with the boundary in place it is refused for an isolated-only agent —
// and there was no way to bring an existing setup into a sandbox at all. A new
// isolated copy started empty.
//
// `--isolated` copies instead: settings in, original untouched, nothing adopted.
describe.skipIf(process.platform === 'win32')('agents import --isolated', () => {
  let home: string;

  const versionsRoot = () => path.join(home, '.agents', '.history', 'versions', 'codex');
  const realConfig = () => path.join(home, '.codex');
  const shimsDir = () => path.join(home, '.agents', '.cache', 'shims');
  const launcher = () => path.join(home, 'npm-global', 'bin', 'codex');

  function run(...args: string[]): { out: string; status: number } {
    try {
      const out = execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env, HOME: home, AGENTS_REAL_HOME: home, SHELL: '/bin/bash',
          AGENTS_NO_NUDGE: '1', FORCE_COLOR: '0',
          PATH: `${path.join(home, 'npm-global', 'bin')}:${process.env.PATH}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8');
      return { out, status: 0 };
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
    }
  }

  const importedVersion = () => {
    const vs = fs.existsSync(versionsRoot()) ? fs.readdirSync(versionsRoot()) : [];
    return vs[0];
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'import-isolated-'));
    // A real npm-layout codex install with a package.json carrying a version.
    const pkgDir = path.join(home, 'npm-global', 'lib', 'node_modules', '@openai', 'codex');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, 'npm-global', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@openai/codex', version: '1.2.3', bin: { codex: 'bin/codex.js' },
    }));
    fs.writeFileSync(path.join(pkgDir, 'bin', 'codex.js'), '#!/bin/sh\necho LOCAL-CODEX\n');
    fs.chmodSync(path.join(pkgDir, 'bin', 'codex.js'), 0o755);
    fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', launcher());

    // The user's real config: a setting worth keeping, plus a credential.
    fs.mkdirSync(path.join(realConfig(), 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "my-setting"\n');
    fs.writeFileSync(path.join(realConfig(), 'prompts', 'review.md'), '# mine\n');
    fs.writeFileSync(path.join(realConfig(), 'auth.json'), '{"token":"SECRET"}\n');

    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('copies settings in and leaves the original exactly where it was', () => {
    const r = run('import', 'codex', '--isolated', '-y');
    expect(r.status).toBe(0);
    const v = importedVersion();
    expect(v).toBeTruthy();

    // Settings landed in the sandbox...
    const seeded = path.join(versionsRoot(), v, 'home', '.codex');
    expect(fs.readFileSync(path.join(seeded, 'config.toml'), 'utf-8')).toContain('my-setting');
    expect(fs.readFileSync(path.join(seeded, 'prompts', 'review.md'), 'utf-8')).toContain('# mine');

    // ...and the user's real config is still a REAL directory with its contents,
    // not moved and not replaced by a symlink into the version home.
    expect(fs.lstatSync(realConfig()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(realConfig(), 'config.toml'), 'utf-8')).toContain('my-setting');
  }, 180_000);

  it('adopts nothing: no default, no bare shim, launcher untouched', () => {
    expect(run('import', 'codex', '--isolated', '-y').status).toBe(0);
    const v = importedVersion();

    expect(fs.existsSync(path.join(versionsRoot(), v, '.isolated'))).toBe(true);
    expect(fs.readlinkSync(launcher())).toBe('../lib/node_modules/@openai/codex/bin/codex.js');
    const shims = fs.existsSync(shimsDir()) ? fs.readdirSync(shimsDir()) : [];
    expect(shims).not.toContain('codex');          // no bare shim...
    expect(shims).toContain(`codex@${v}`);          // ...only the versioned alias
    // No global default recorded anywhere.
    const devices = path.join(home, '.agents', 'devices');
    const pins = fs.existsSync(devices)
      ? fs.readdirSync(devices).map((d) => fs.readFileSync(path.join(devices, d, 'agents.yaml'), 'utf-8')).join('')
      : '';
    expect(pins).not.toMatch(/^agents:\s*\n\s+codex:/m);
  }, 180_000);

  it('skips credentials by default and says so', () => {
    const r = run('import', 'codex', '--isolated', '-y');
    const v = importedVersion();
    const seeded = path.join(versionsRoot(), v, 'home', '.codex');

    expect(fs.existsSync(path.join(seeded, 'auth.json'))).toBe(false);
    expect(r.out).toContain('Credentials NOT copied');
    expect(r.out).toContain('auth.json');
    // The user's own credential is of course untouched.
    expect(fs.readFileSync(path.join(realConfig(), 'auth.json'), 'utf-8')).toContain('SECRET');
  }, 180_000);

  it('--with-auth opts in explicitly', () => {
    expect(run('import', 'codex', '--isolated', '--with-auth', '-y').status).toBe(0);
    const v = importedVersion();
    const seeded = path.join(versionsRoot(), v, 'home', '.codex');
    expect(fs.readFileSync(path.join(seeded, 'auth.json'), 'utf-8')).toContain('SECRET');
  }, 180_000);

  it('is allowed while the agent is isolation-protected — plain import is not', () => {
    // First isolated import makes codex isolated-only, hence protected.
    expect(run('import', 'codex', '--isolated', '-y').status).toBe(0);
    // Plain import would adopt: refused.
    expect(run('import', 'codex', '-y').out).toContain('installed only as isolated copies');
    // Another isolated import is still fine — it adopts nothing.
    const again = run('import', 'codex', '--isolated', '-y');
    expect(again.out).not.toContain('installed only as isolated copies');
  }, 180_000);
});
