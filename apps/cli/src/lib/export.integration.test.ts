import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `agents export` is the exit door for `--isolated`: it copies a sandboxed install's
// config out to the user's real ~/.<agent> so they can keep their settings and delete
// agents-cli. Drives the real CLI against a throwaway HOME — no mocking — because the
// whole feature is filesystem behavior (backup, replace, symlink stripping).
describe.skipIf(process.platform === 'win32')('agents export — isolated config out to the real config dir', () => {
  let home: string;
  const V = '9.9.4';

  const versionDir = (v = V) => path.join(home, '.agents', '.history', 'versions', 'codex', v);
  const isolatedConfig = (v = V) => path.join(versionDir(v), 'home', '.codex');
  const realConfig = () => path.join(home, '.codex');

  function plantIsolated(v = V, { isolated = true } = {}) {
    const binDir = path.join(versionDir(v), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    // isVersionInstalled resolves the launch binary, so the fixture needs a real file.
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'codex'), 0o755);
    fs.mkdirSync(isolatedConfig(v), { recursive: true });
    fs.writeFileSync(path.join(isolatedConfig(v), 'config.toml'), 'model = "sandboxed"\n');
    if (isolated) fs.writeFileSync(path.join(versionDir(v), '.isolated'), '2026-07-30T00:00:00.000Z\n');
  }

  function run(...args: string[]): { out: string; status: number } {
    try {
      const out = execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), ...args], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home, SHELL: '/bin/bash', AGENTS_NO_NUDGE: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8');
      return { out, status: 0 };
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
    }
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-export-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('creates the real config dir when the user has none', () => {
    plantIsolated();
    const r = run('export', `codex@${V}`, '--yes');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(realConfig(), 'config.toml'), 'utf-8')).toContain('sandboxed');
  }, 120_000);

  it('backs up an existing real config instead of destroying it', () => {
    plantIsolated();
    fs.mkdirSync(realConfig(), { recursive: true });
    fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "my-original"\n');

    const r = run('export', `codex@${V}`, '--yes');
    expect(r.status).toBe(0);
    // New config landed...
    expect(fs.readFileSync(path.join(realConfig(), 'config.toml'), 'utf-8')).toContain('sandboxed');
    // ...and the original survives somewhere under the backups dir.
    const backupsRoot = path.join(home, '.agents', '.history', 'backups', 'codex');
    const stamps = fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot) : [];
    expect(stamps.length).toBeGreaterThan(0);
    const restored = path.join(backupsRoot, stamps[0], 'config.toml');
    expect(fs.readFileSync(restored, 'utf-8')).toContain('my-original');
  }, 120_000);

  it('strips symlinks into ~/.agents so the export stands alone', () => {
    plantIsolated();
    // Managed resources are synced into a version home as links into ~/.agents.
    const skillsSrc = path.join(home, '.agents', 'skills');
    fs.mkdirSync(skillsSrc, { recursive: true });
    fs.writeFileSync(path.join(skillsSrc, 'SKILL.md'), '# managed\n');
    fs.symlinkSync(skillsSrc, path.join(isolatedConfig(), 'skills'));
    // A link to something OUTSIDE ~/.agents is the user's own and must survive.
    const mine = path.join(home, 'my-notes');
    fs.mkdirSync(mine, { recursive: true });
    fs.symlinkSync(mine, path.join(isolatedConfig(), 'notes'));

    expect(run('export', `codex@${V}`, '--yes').status).toBe(0);
    expect(fs.existsSync(path.join(realConfig(), 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(realConfig(), 'notes'))).toBe(true);
    expect(fs.readFileSync(path.join(realConfig(), 'config.toml'), 'utf-8')).toContain('sandboxed');
  }, 120_000);

  it('--dry-run writes nothing', () => {
    plantIsolated();
    fs.mkdirSync(realConfig(), { recursive: true });
    fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "my-original"\n');

    const r = run('export', `codex@${V}`, '--dry-run');
    expect(r.status).toBe(0);
    expect(r.out).toContain('Dry run');
    expect(fs.readFileSync(path.join(realConfig(), 'config.toml'), 'utf-8')).toContain('my-original');
  }, 120_000);

  it('refuses a NON-isolated version and changes nothing', () => {
    plantIsolated(V, { isolated: false });
    const r = run('export', `codex@${V}`, '--yes');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('not an isolated install');
    expect(fs.existsSync(realConfig())).toBe(false);
  }, 120_000);

  it('refuses when the real config is a symlink agents-cli already adopted', () => {
    plantIsolated();
    // Another version adopted ~/.codex — writing there would mutate ITS home.
    plantIsolated('9.9.5', { isolated: false });
    fs.symlinkSync(isolatedConfig('9.9.5'), realConfig());

    const r = run('export', `codex@${V}`, '--yes');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('managed by agents-cli');
    // The adopted target is untouched.
    expect(fs.readFileSync(path.join(isolatedConfig('9.9.5'), 'config.toml'), 'utf-8')).toContain('sandboxed');
    expect(fs.lstatSync(realConfig()).isSymbolicLink()).toBe(true);
  }, 120_000);

  it('resolves the version when exactly one isolated copy exists', () => {
    plantIsolated();
    const r = run('export', 'codex', '--yes');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(realConfig(), 'config.toml'), 'utf-8')).toContain('sandboxed');
  }, 120_000);
});
