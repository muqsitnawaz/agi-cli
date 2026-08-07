import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { Command } from 'commander';

// End-to-end command test on the REAL filesystem (no mocks): a fabricated claude
// install, the real `accounts` command actions, and assertions on the files they
// write. This is what catches the device-default bug the earlier draft had —
// writing bindings under os.hostname() while `run` read them under machineId().
let TMP = '';

async function freshProgram() {
  vi.resetModules();
  const { registerAccountsCommand } = await import('./accounts.js');
  const program = new Command();
  program.exitOverride();
  registerAccountsCommand(program);
  return program;
}

function installClaude(version: string, email: string, acct: string, org: string) {
  const verDir = path.join(TMP, '.agents', '.history', 'versions', 'claude', version);
  const pkgDir = path.join(verDir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
  fs.writeFileSync(path.join(pkgDir, 'cli.js'), '// stub');
  const claudeDir = path.join(verDir, 'home', '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: acct, organizationUuid: org, emailAddress: email, organizationType: 'claude_max' } }),
  );
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-cmd-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

const registryFile = () => path.join(TMP, '.agents', 'accounts.yaml');
const bindingsFile = () => path.join(TMP, '.agents', 'devices', 'testbox', 'accounts.yaml');

describe('agents accounts command', () => {
  it('label writes a fingerprint centrally and a binding under devices/<machineId>/', async () => {
    installClaude('2.1.100', 'me@work.co', 'acc-1', 'org-1');
    const program = await freshProgram();
    await program.parseAsync(['accounts', 'label', 'work', 'claude@2.1.100'], { from: 'user' });

    const registry = yaml.parse(fs.readFileSync(registryFile(), 'utf-8'));
    expect(Object.keys(registry.labels)).toEqual(['work']);
    expect(registry.labels.work.claude).toMatch(/^[0-9a-f]{32}$/);
    // The synced registry carries no raw email.
    expect(fs.readFileSync(registryFile(), 'utf-8')).not.toContain('me@work.co');

    // Binding is under the NORMALIZED machine id (testbox), the same key `run` reads.
    const bindings = yaml.parse(fs.readFileSync(bindingsFile(), 'utf-8'));
    expect(bindings.bindings.work.claude).toEqual(['2.1.100']);
  });

  it("attach agent@* binds version-global and refuses a foreign identity", async () => {
    installClaude('2.1.100', 'me@work.co', 'acc-1', 'org-1');
    installClaude('2.1.101', 'me@work.co', 'acc-1', 'org-1');
    const program = await freshProgram();
    await program.parseAsync(['accounts', 'label', 'work', 'claude@2.1.100'], { from: 'user' });
    // A second claude signed into a DIFFERENT identity cannot join 'work'.
    installClaude('2.1.200', 'other@personal.co', 'acc-2', 'org-2');
    const p2 = await freshProgram();
    await expect(
      p2.parseAsync(['accounts', 'attach', 'work', 'claude@2.1.200'], { from: 'user' }),
    ).rejects.toThrow(/different identity/);

    // '*' collapses to version-global.
    const p3 = await freshProgram();
    await p3.parseAsync(['accounts', 'attach', 'work', 'claude@*'], { from: 'user' });
    const bindings = yaml.parse(fs.readFileSync(bindingsFile(), 'utf-8'));
    expect(bindings.bindings.work.claude).toEqual(['*']);
  });

  it('rejects labeling a version that is not installed', async () => {
    installClaude('2.1.100', 'me@work.co', 'acc-1', 'org-1');
    const program = await freshProgram();
    await expect(
      program.parseAsync(['accounts', 'label', 'work', 'claude@9.9.9'], { from: 'user' }),
    ).rejects.toThrow(/claude@9.9.9 is not installed/);
  });
});
