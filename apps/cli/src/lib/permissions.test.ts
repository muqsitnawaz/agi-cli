import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import {
  COMPUTER_APP_GATED_VERBS,
  applyPermissionsToVersion,
  buildPermissionsFromGroups,
  containsBroadGrants,
  convertDenyToCodexRules,
  convertToKimiFormat,
  convertToKiroFormat,
  formatComputerPermissionGrantHint,
} from './permissions.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-perms-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('permission path handling', () => {
  it('rejects traversal in permission group names', async () => {
    makeTempHome();

    expect(() => buildPermissionsFromGroups(['../outside'])).toThrow('Invalid name: ../outside.yaml');
  });

  it('escapes deny rules before writing Codex Starlark string literals', async () => {
    const rules = convertDenyToCodexRules(['Bash(git "status":*)']);

    expect(rules).toContain('"git", "\\"status\\""');
    expect(rules).not.toContain('"git", ""status""');
  });
});

describe('containsBroadGrants', () => {
  it('flags Bash(*) permission packs as broad grants', () => {
    const result = containsBroadGrants({
      name: 'broad',
      allow: ['Bash(*)'],
      deny: [],
    });

    expect(result?.broad).toEqual(['Bash(*)']);
    expect(result?.reason).toContain('approval_policy=never');
  });

  it('allows narrow permission packs', () => {
    const result = containsBroadGrants({
      name: 'narrow',
      allow: ['Bash(git status:*)'],
      deny: [],
      additionalDirectories: ['src'],
    });

    expect(result).toBeNull();
  });
});

describe('computer permission hints', () => {
  it('tells users the app-targeted verbs gated by Computer(bundle-id)', () => {
    const hint = formatComputerPermissionGrantHint('Microsoft.WindowsNotepad');

    expect(hint).toContain('Computer(Microsoft.WindowsNotepad)');
    expect(hint).toContain('agents computer reload');
    expect(hint).toContain('type-text');
    expect(hint).toContain('key');
    expect(COMPUTER_APP_GATED_VERBS).toContain('type-text');
    expect(COMPUTER_APP_GATED_VERBS).toContain('key');
  });
});

describe('convertToKimiFormat', () => {
  it('translates Claude `:*` bash patterns into Kimi globs, with a slash-crossing variant', () => {
    // The core bug: copying `Bash(git status:*)` verbatim never matches in
    // Kimi's engine (it globs the raw command string), so every call prompts.
    // The second `*​/**` form is required because Kimi's `*` does not cross `/`,
    // so a bare `cmd*` misses any path argument (`git push origin feat/x`).
    const { permission } = convertToKimiFormat({
      name: 'core',
      allow: ['Bash(git push:*)', 'Bash(mq:*)', 'Bash(env)'],
      deny: [],
    });

    expect(permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash(git push*)' },
      { decision: 'allow', pattern: 'Bash(git push*/**)' },
      { decision: 'allow', pattern: 'Bash(mq*)' },
      { decision: 'allow', pattern: 'Bash(mq*/**)' },
      // Exact command (no `:*`) takes no path args — single rule, no slash variant.
      { decision: 'allow', pattern: 'Bash(env)' },
    ]);
  });

  it('collapses blanket and glob grants to name-only rules with original casing', () => {
    const { permission } = convertToKimiFormat({
      name: 'broad',
      allow: ['Bash(*)', 'Read(**)', 'Grep'],
      deny: [],
    });

    expect(permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash' },
      { decision: 'allow', pattern: 'Read' },
      { decision: 'allow', pattern: 'Grep' },
    ]);
  });

  it('carries deny rules through the same translation', () => {
    const { permission } = convertToKimiFormat({
      name: 'deny',
      allow: [],
      deny: ['Bash(rm -rf:*)'],
    });

    expect(permission.rules).toEqual([
      { decision: 'deny', pattern: 'Bash(rm -rf*)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*/**)' },
    ]);
  });

  it('writes a re-parseable TOML config with translated patterns (no raw `:*`)', () => {
    const home = makeTempHome();
    const res = applyPermissionsToVersion(
      'kimi',
      { name: 'set', allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] },
      home,
      false,
    );
    expect(res.success).toBe(true);

    const raw = fs.readFileSync(path.join(home, '.kimi-code', 'config.toml'), 'utf-8');
    const parsed = TOML.parse(raw) as { permission: { rules: Array<{ decision: string; pattern: string }> } };
    expect(parsed.permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash(ls*)' },
      { decision: 'allow', pattern: 'Bash(ls*/**)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*/**)' },
    ]);
    // The pre-fix bug would have left the un-matchable Claude `:*` form on disk.
    expect(raw).not.toContain(':*');
  });
});

describe('convertToKiroFormat', () => {
  it('maps canonical tools to Kiro capabilities and strips the domain: prefix', () => {
    const { rules } = convertToKiroFormat({
      name: 'core',
      allow: ['Bash(git status:*)', 'Read(**)', 'Write(src/**)', 'WebFetch(domain:docs.example.com/*)', 'WebSearch'],
      deny: ['Bash(sudo:*)'],
    });

    expect(rules).toEqual([
      { capability: 'shell', effect: 'allow', match: ['git status *'] },
      { capability: 'fs_read', effect: 'allow' },
      { capability: 'fs_write', effect: 'allow', match: ['src/**'] },
      { capability: 'web_fetch', effect: 'allow', match: ['docs.example.com/*'] },
      { capability: 'web_search', effect: 'allow' },
      { capability: 'shell', effect: 'deny', match: ['sudo *'] },
    ]);
  });

  it('writes a re-parseable permissions.yaml under the Kiro settings dir', () => {
    const home = makeTempHome();
    const res = applyPermissionsToVersion(
      'kiro',
      { name: 'set', allow: ['Bash(ls:*)', 'Read(**)'], deny: ['Bash(rm -rf:*)'] },
      home,
      false,
    );
    expect(res.success).toBe(true);

    const configPath = path.join(home, '.kiro', 'settings', 'permissions.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8')) as { rules: Array<{ capability: string; effect: string; match?: string[] }> };
    expect(parsed.rules).toContainEqual({ capability: 'shell', effect: 'allow', match: ['ls *'] });
    expect(parsed.rules).toContainEqual({ capability: 'fs_read', effect: 'allow' });
    expect(parsed.rules).toContainEqual({ capability: 'shell', effect: 'deny', match: ['rm -rf *'] });
  });
});
