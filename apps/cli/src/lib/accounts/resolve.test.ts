import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real filesystem, no mocks: we fabricate a genuine claude version install
// (node_modules bin + a per-version home with .claude.json) so listInstalledVersions,
// getVersionHomePath, getAccountInfo, and accountFingerprint all run for real.
let TMP = '';

async function fresh() {
  vi.resetModules();
  const resolve = await import('./resolve.js');
  const registry = await import('./registry.js');
  const capability = await import('./capability.js');
  const agents = await import('../agents.js');
  const versions = await import('../versions.js');
  return { ...resolve, ...registry, ...capability, agents, versions };
}

/** Create a real, "installed" claude version signed into `email`/`acct`. */
function installClaude(version: string, email: string, acct: string, org: string) {
  const verDir = path.join(TMP, '.agents', '.history', 'versions', 'claude', version);
  const pkgDir = path.join(verDir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
  fs.writeFileSync(path.join(pkgDir, 'cli.js'), '// launch stub');
  const claudeDir = path.join(verDir, 'home', '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { accountUuid: acct, organizationUuid: org, emailAddress: email, organizationType: 'claude_max' },
    }),
  );
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-resolve-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});
afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('resolveAccountLabel (fail-loud verified routing)', () => {
  it('resolves to the installed version whose live identity matches the label', async () => {
    const mod = await fresh();
    installClaude('2.1.100', 'me@work.co', 'acc-work', 'org-work');
    const info = await mod.agents.getAccountInfo('claude', mod.versions.getVersionHomePath('claude', '2.1.100'));
    const fp = mod.accountFingerprint('claude', info)!;
    expect(fp).toBeTruthy();

    const reg = mod.readAccountLabels();
    mod.setLabelIdentity(reg, 'work', 'claude', fp);
    mod.writeAccountLabels(reg);

    const res = await mod.resolveAccountLabel('claude', 'work');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.version).toBe('2.1.100');
  });

  it('fails loud (never falls back) when the only install is a different identity', async () => {
    const mod = await fresh();
    installClaude('2.1.100', 'other@personal.co', 'acc-personal', 'org-personal');
    // Label 'work' names an identity NOT signed in on any installed version.
    const reg = mod.readAccountLabels();
    mod.setLabelIdentity(reg, 'work', 'claude', 'a-fingerprint-nothing-matches');
    mod.writeAccountLabels(reg);

    const res = await mod.resolveAccountLabel('claude', 'work');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/never falls back/);
  });

  it('fails when the label is unknown', async () => {
    const mod = await fresh();
    const res = await mod.resolveAccountLabel('claude', 'ghost');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/No account label 'ghost'/);
  });

  it('fails when the label has no identity for the harness', async () => {
    const mod = await fresh();
    const reg = mod.readAccountLabels();
    mod.setLabelIdentity(reg, 'work', 'codex', 'fp');
    mod.writeAccountLabels(reg);
    const res = await mod.resolveAccountLabel('claude', 'work');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no claude identity/);
  });

  it('refuses a non-labelable harness', async () => {
    const mod = await fresh();
    const res = await mod.resolveAccountLabel('openclaw', 'work');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/does not support account labels/);
  });
});
