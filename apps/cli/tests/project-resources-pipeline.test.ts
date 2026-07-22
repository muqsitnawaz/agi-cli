/**
 * Project-resource pipeline integration tests.
 *
 * Drives compileRulesForProject + resolveResource + listMcpServerConfigs
 * against the checked-in fixture at tests/fixtures/project-resources/.
 * No agent CLI invocations, no LLM calls — pure filesystem assertions.
 *
 * Mock strategy: redirect getUserAgentsDir/getSystemAgentsDir/etc. to empty
 * temp dirs so the project layer is the only one with content. The real
 * getProjectAgentsDir walk-up is preserved (project discovery is what we're
 * actually testing).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let TEMP_ROOT = '';
let USER_DIR = '';
let SYSTEM_DIR = '';
let VERSIONS_DIR = '';

vi.mock('../src/lib/state.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/state.js')>('../src/lib/state.js');
  return {
    ...actual,
    getUserAgentsDir: () => USER_DIR,
    getSystemAgentsDir: () => SYSTEM_DIR,
    getAgentsDir: () => SYSTEM_DIR,
    getUserRulesDir: () => path.join(USER_DIR, 'rules'),
    getResolvedRulesDir: () => path.join(SYSTEM_DIR, 'rules'),
    getEnabledExtraRepos: () => [],
    getMcpDir: () => path.join(SYSTEM_DIR, 'mcp'),
    getUserMcpDir: () => path.join(USER_DIR, 'mcp'),
    // Additional getters used by syncResourcesToVersion. Each points at the
    // empty system root so no central resources resolve — the project layer
    // is the sole source.
    getVersionsDir: () => VERSIONS_DIR,
    getCommandsDir: () => path.join(SYSTEM_DIR, 'commands'),
    getSkillsDir: () => path.join(SYSTEM_DIR, 'skills'),
    getHooksDir: () => path.join(SYSTEM_DIR, 'hooks'),
    getSubagentsDir: () => path.join(SYSTEM_DIR, 'subagents'),
    getPermissionsDir: () => path.join(SYSTEM_DIR, 'permissions'),
    getPromptcutsPath: () => path.join(SYSTEM_DIR, 'promptcuts.yaml'),
    getUserPromptcutsPath: () => path.join(USER_DIR, 'promptcuts.yaml'),
    getTrashVersionsDir: () => path.join(VERSIONS_DIR, '.trash'),
    getActivePermissionPresetName: () => null,
    getActiveRulesPreset: () => null,
  };
});

const FIXTURE_SRC = path.resolve(__dirname, 'fixtures', 'project-resources');

interface FixtureLayout {
  repoRoot: string;
  siblingRoot: string;
  nestedCwd: string;
}

function setupFixture(): FixtureLayout {
  TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-res-'));
  fs.mkdirSync(path.join(TEMP_ROOT, '.git'), { recursive: true });
  // Recursive copy that preserves symlinks/empty dirs and hidden .agents/.
  // fs.cpSync is cross-platform — the old `cp -R` spawn assumed a POSIX `cp`
  // on PATH, which the windows-latest runner does not provide. Default
  // dereference:false copies symlinks as links, matching `cp -R`.
  fs.cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  USER_DIR = path.join(TEMP_ROOT, '_user_empty');
  SYSTEM_DIR = path.join(TEMP_ROOT, '_system_empty');
  VERSIONS_DIR = path.join(TEMP_ROOT, '_versions');
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(SYSTEM_DIR, { recursive: true });
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  return {
    repoRoot: path.join(TEMP_ROOT, 'repo'),
    siblingRoot: path.join(TEMP_ROOT, 'sibling'),
    nestedCwd: path.join(TEMP_ROOT, 'repo', 'sub', 'deep'),
  };
}

afterEach(() => {
  if (TEMP_ROOT && fs.existsSync(TEMP_ROOT)) {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
  TEMP_ROOT = '';
  USER_DIR = '';
  SYSTEM_DIR = '';
});

describe('project-resources: walk-up discovery', () => {
  it('finds <repo>/.agents from a nested cwd', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    const { getProjectAgentsDir } = await import('../src/lib/state.js');
    expect(getProjectAgentsDir(nestedCwd)).toBe(path.join(repoRoot, '.agents'));
  });

  it('returns null from a sibling dir without .agents', async () => {
    const { siblingRoot } = setupFixture();
    const { getProjectAgentsDir } = await import('../src/lib/state.js');
    expect(getProjectAgentsDir(siblingRoot)).toBeNull();
  });

  it('finds project from the repo root itself', async () => {
    const { repoRoot } = setupFixture();
    const { getProjectAgentsDir } = await import('../src/lib/state.js');
    expect(getProjectAgentsDir(repoRoot)).toBe(path.join(repoRoot, '.agents'));
  });
});

describe('project-resources: compileRulesForProject', () => {
  it('writes <repo>/AGENTS.md containing both project subrule tokens', async () => {
    const { repoRoot } = setupFixture();
    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');

    const result = compileRulesForProject(repoRoot);

    expect(result.compiled).toBe(true);
    expect(result.skippedClobber).toEqual([]);
    expect(result.sources).toBeGreaterThanOrEqual(2);

    const compiled = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf-8');
    expect(compiled).toContain('RULE_TOKEN_PROJECT_LEVEL_RULE_LOADED');
    expect(compiled).toContain('SECRET_TOKEN_FRAGMENT_INLINED');
    // Compiled header marks ownership for idempotency / clobber-guard.
    expect(compiled.startsWith('<!-- Auto-compiled by agents-cli')).toBe(true);
  });

  it('creates per-agent symlinks (CLAUDE.md, GEMINI.md) → AGENTS.md', async () => {
    const { repoRoot } = setupFixture();
    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');

    compileRulesForProject(repoRoot);

    for (const fname of ['CLAUDE.md', 'GEMINI.md']) {
      const p = path.join(repoRoot, fname);
      expect(fs.existsSync(p)).toBe(true);
      const st = fs.lstatSync(p);
      expect(st.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(p)).toBe('AGENTS.md');
    }
  });

  it('is idempotent — second run does not rewrite when content is unchanged', async () => {
    const { repoRoot } = setupFixture();
    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');

    const r1 = compileRulesForProject(repoRoot);
    expect(r1.compiled).toBe(true);

    const r2 = compileRulesForProject(repoRoot);
    expect(r2.compiled).toBe(false);
    expect(r2.skippedClobber).toEqual([]);
  });

  it('refuses to clobber a user-authored AGENTS.md (no compiled header)', async () => {
    const { repoRoot } = setupFixture();
    const userOwned = '# my hand-written project rules\nDO_NOT_TOUCH_USER_FILE\n';
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), userOwned);

    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');
    const result = compileRulesForProject(repoRoot);

    expect(result.skippedClobber).toContain('AGENTS.md');
    const after = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf-8');
    expect(after).toBe(userOwned);
    expect(after).not.toContain('RULE_TOKEN_PROJECT_LEVEL_RULE_LOADED');
  });

  it('is a no-op when <cwd>/.agents/rules/ does not exist', async () => {
    const { siblingRoot } = setupFixture();
    const { compileRulesForProject } = await import('../src/lib/rules/compile.js');

    const result = compileRulesForProject(siblingRoot);

    expect(result.compiled).toBe(false);
    expect(result.sources).toBe(0);
    expect(fs.existsSync(path.join(siblingRoot, 'AGENTS.md'))).toBe(false);
  });
});

describe('project-resources: resolveResource project precedence', () => {
  it('resolves the project command from a nested cwd', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    const { resolveResource } = await import('../src/lib/resources.js');

    const r = resolveResource('commands', 'myproj', nestedCwd);

    expect(r).not.toBeNull();
    expect(r!.source).toBe('project');
    expect(r!.path).toBe(path.join(repoRoot, '.agents', 'commands', 'myproj.md'));
    expect(fs.readFileSync(r!.path, 'utf-8')).toContain('CMD_TOKEN_PROJECT_COMMAND_AVAILABLE');
  });

  it('project command beats user/system on name collision', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    // Plant a same-named command in the (mocked) user dir — project should still win.
    const userCmdDir = path.join(USER_DIR, 'commands');
    fs.mkdirSync(userCmdDir, { recursive: true });
    fs.writeFileSync(path.join(userCmdDir, 'myproj.md'), '# user command — should NOT win\nUSER_TOKEN\n');

    const { resolveResource } = await import('../src/lib/resources.js');
    const r = resolveResource('commands', 'myproj', nestedCwd);

    expect(r!.source).toBe('project');
    expect(r!.path).toBe(path.join(repoRoot, '.agents', 'commands', 'myproj.md'));
  });

  it('resolves the project skill', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    const { resolveResource } = await import('../src/lib/resources.js');

    const r = resolveResource('skills', 'myskill', nestedCwd);

    expect(r).not.toBeNull();
    expect(r!.source).toBe('project');
    expect(r!.path).toBe(path.join(repoRoot, '.agents', 'skills', 'myskill'));
    const body = fs.readFileSync(path.join(r!.path, 'SKILL.md'), 'utf-8');
    expect(body).toContain('SKILL_TOKEN_PROJECT_SKILL_AVAILABLE');
  });

  it('returns null for an unknown command', async () => {
    const { nestedCwd } = setupFixture();
    const { resolveResource } = await import('../src/lib/resources.js');
    expect(resolveResource('commands', 'does-not-exist', nestedCwd)).toBeNull();
  });

  it('returns null from a sibling cwd (no project, empty user/system)', async () => {
    const { siblingRoot } = setupFixture();
    const { resolveResource } = await import('../src/lib/resources.js');
    expect(resolveResource('commands', 'myproj', siblingRoot)).toBeNull();
  });
});

describe('project-resources: syncResourcesToVersion security defense', () => {
  // Commit 1cc35b14 (fix(security): project-resource defense) closed a
  // threat-class: a cloned public repo could ship .agents/commands/foo.md
  // with a harmful body, and the next `agents run` would materialize that
  // file under the agent's prompt surface. The fix unconditionally excludes
  // the project layer from sync for commands/skills/MCP/subagents/permissions.
  // resolveResource still surfaces project entries for listing/inspection;
  // only the materializing pipeline is locked down.
  //
  // These tests pin the defense at the sync layer. If a future change re-adds
  // project-layer materialization without a confirm step, these assertions
  // flip and the threat returns.
  it('does NOT materialize a project command into version home, regardless of cwd', async () => {
    const { repoRoot } = setupFixture();
    const { syncResourcesToVersion } = await import('../src/lib/versions.js');
    const { resolveResource } = await import('../src/lib/resources.js');

    // Sanity: the fixture's project command resolves, so the resolver still
    // sees it. This is the "list / inspect" path that must keep working.
    const resolved = resolveResource('commands', 'myproj', repoRoot);
    expect(resolved?.source).toBe('project');

    // But sync must NOT plant it under the agent's prompt surface.
    syncResourcesToVersion('claude', '99.99.99', undefined, { cwd: repoRoot, force: true });

    const versionCmd = path.join(VERSIONS_DIR, 'claude', '99.99.99', 'home', '.claude', 'commands', 'myproj.md');
    expect(fs.existsSync(versionCmd)).toBe(false);
  });

  it('does NOT materialize a project skill into version home, regardless of cwd', async () => {
    const { repoRoot } = setupFixture();
    const { syncResourcesToVersion } = await import('../src/lib/versions.js');
    const { resolveResource } = await import('../src/lib/resources.js');

    const resolved = resolveResource('skills', 'myskill', repoRoot);
    expect(resolved?.source).toBe('project');

    syncResourcesToVersion('claude', '99.99.99', undefined, { cwd: repoRoot, force: true });

    const versionSkill = path.join(VERSIONS_DIR, 'claude', '99.99.99', 'home', '.claude', 'skills', 'myskill');
    expect(fs.existsSync(versionSkill)).toBe(false);
  });

  it('does NOT materialize project-only resources into project agent dirs', async () => {
    const { repoRoot } = setupFixture();
    const projectAgentsDir = path.join(repoRoot, '.agents');
    fs.mkdirSync(path.join(projectAgentsDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(projectAgentsDir, 'hooks', 'evil.sh'), '#!/bin/sh\necho evil\n', { mode: 0o755 });
    fs.mkdirSync(path.join(projectAgentsDir, 'subagents', 'evilagent'), { recursive: true });
    fs.writeFileSync(path.join(projectAgentsDir, 'subagents', 'evilagent', 'AGENT.md'), [
      '---',
      'name: evilagent',
      'description: project-only subagent',
      '---',
      '',
      'SUBAGENT_TOKEN_PROJECT_ONLY',
      '',
    ].join('\n'));

    const { syncResourcesToVersion } = await import('../src/lib/versions.js');

    const result = syncResourcesToVersion('claude', '99.99.99', undefined, { cwd: repoRoot, force: true });

    expect(result.commands).toBe(false);
    expect(result.skills).toBe(false);
    expect(result.hooks).toBe(false);
    expect(result.mcp).not.toContain('proj-mcp-fixture');
    expect(result.subagents).not.toContain('evilagent');
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'commands', 'myproj.md'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'skills', 'myskill'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'hooks', 'evil.sh'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.claude', 'agents', 'evilagent.md'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, '.mcp.json'))).toBe(false);
  });

  it('materializes a project hook override when a trusted same-name hook exists', async () => {
    const { repoRoot } = setupFixture();
    const projectHooksDir = path.join(repoRoot, '.agents', 'hooks');
    const userHooksDir = path.join(USER_DIR, 'hooks');
    fs.mkdirSync(projectHooksDir, { recursive: true });
    fs.mkdirSync(userHooksDir, { recursive: true });
    fs.writeFileSync(path.join(projectHooksDir, 'shared.sh'), '#!/bin/sh\necho project-hook\n', { mode: 0o755 });
    fs.writeFileSync(path.join(userHooksDir, 'shared.sh'), '#!/bin/sh\necho user-hook\n', { mode: 0o755 });

    const { syncResourcesToVersion } = await import('../src/lib/versions.js');
    const { getAvailableResources } = await import('../src/lib/versions.js');

    expect(getAvailableResources(repoRoot).hooks).toContain('shared.sh');
    const result = syncResourcesToVersion('claude', '99.99.99', undefined, { cwd: repoRoot, force: true });

    expect(result.hooks).toBe(true);
    const projectHook = path.join(repoRoot, '.claude', 'hooks', 'shared.sh');
    expect(fs.existsSync(projectHook)).toBe(true);
    expect(fs.readFileSync(projectHook, 'utf-8')).toContain('project-hook');
  });

  it('does NOT materialize a trusted same-name project MCP override into version home', async () => {
    const { repoRoot } = setupFixture();
    const projectMcpDir = path.join(repoRoot, '.agents', 'mcp');
    const userMcpDir = path.join(USER_DIR, 'mcp');
    fs.mkdirSync(projectMcpDir, { recursive: true });
    fs.mkdirSync(userMcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectMcpDir, 'foo.yaml'),
      ['name: foo', 'transport: stdio', 'command: PROJECT-OVERRIDE-COMMAND', ''].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(userMcpDir, 'foo.yaml'),
      ['name: foo', 'transport: stdio', 'command: user-safe-command', ''].join('\n'),
      'utf-8'
    );

    const { syncResourcesToVersion } = await import('../src/lib/versions.js');
    const { trustProjectMcp } = await import('../src/lib/mcp.js');

    trustProjectMcp(repoRoot);
    const result = syncResourcesToVersion('opencode', '2.0.0', { mcp: ['foo'] }, { cwd: repoRoot, force: true });

    const versionConfig = path.join(VERSIONS_DIR, 'opencode', '2.0.0', 'home', '.config', 'opencode', 'opencode.jsonc');
    expect(fs.existsSync(versionConfig)).toBe(false);

    const projectConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, '.opencode', 'opencode.jsonc'), 'utf-8')) as {
      mcp?: Record<string, { command?: string[] }>;
    };
    expect(result.mcp).toEqual(['foo']);
    expect(projectConfig.mcp?.foo?.command).toEqual(['PROJECT-OVERRIDE-COMMAND']);
  });

  it('shrinking the project MCP selection removes only the dropped server, not the whole config file', async () => {
    // Regression: cleanupRemoved used to treat the shared MCP config file as a
    // per-server managed path and delete the entire file when any server dropped
    // out of the selection, wiping still-selected + user-authored entries. The
    // surgical per-key delete lives in removeMcpEntries; cleanupRemoved must skip mcp.
    const { repoRoot } = setupFixture();
    const projectMcpDir = path.join(repoRoot, '.agents', 'mcp');
    const userMcpDir = path.join(USER_DIR, 'mcp');
    fs.mkdirSync(projectMcpDir, { recursive: true });
    fs.mkdirSync(userMcpDir, { recursive: true });
    for (const name of ['foo', 'bar']) {
      fs.writeFileSync(
        path.join(projectMcpDir, `${name}.yaml`),
        ['name: ' + name, 'transport: stdio', 'command: cmd-' + name, ''].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(userMcpDir, `${name}.yaml`),
        ['name: ' + name, 'transport: stdio', 'command: user-' + name, ''].join('\n'),
        'utf-8'
      );
    }

    const { syncResourcesToVersion } = await import('../src/lib/versions.js');
    const { trustProjectMcp } = await import('../src/lib/mcp.js');
    trustProjectMcp(repoRoot);

    // First sync: both servers selected.
    const first = syncResourcesToVersion('opencode', '2.0.0', { mcp: ['foo', 'bar'] }, { cwd: repoRoot, force: true });
    expect(first.mcp.sort()).toEqual(['bar', 'foo']);
    const configFile = path.join(repoRoot, '.opencode', 'opencode.jsonc');
    expect(fs.existsSync(configFile)).toBe(true);

    // Second sync: selection shrinks to just foo. bar must be surgically removed
    // while the config file (and foo) survive.
    const second = syncResourcesToVersion('opencode', '2.0.0', { mcp: ['foo'] }, { cwd: repoRoot, force: true });
    expect(second.mcp).toEqual(['foo']);

    expect(fs.existsSync(configFile)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as { mcp?: Record<string, unknown> };
    expect(Object.keys(config.mcp ?? {})).toEqual(['foo']);
    expect(config.mcp?.bar).toBeUndefined();
  });
});

describe('project-resources: listMcpServerConfigs', () => {
  it('discovers project mcp yaml from a nested cwd and tags it scope=project', async () => {
    const { repoRoot, nestedCwd } = setupFixture();
    const { listMcpServerConfigs } = await import('../src/lib/mcp.js');

    const configs = listMcpServerConfigs(nestedCwd);
    const proj = configs.find((c) => c.name === 'proj-mcp-fixture');

    expect(proj).toBeDefined();
    expect(proj!.scope).toBe('project');
    expect(proj!.path).toBe(path.join(repoRoot, '.agents', 'mcp', 'proj-mcp.yaml'));
    expect(proj!.config.transport).toBe('stdio');
    expect(proj!.config.command).toBe('/usr/bin/true');
    expect(proj!.config.args).toContain('MCP_TOKEN_PROJECT_MCP_AVAILABLE');
  });

  it('returns no project mcp from a sibling cwd', async () => {
    const { siblingRoot } = setupFixture();
    const { listMcpServerConfigs } = await import('../src/lib/mcp.js');

    const configs = listMcpServerConfigs(siblingRoot);

    expect(configs.find((c) => c.name === 'proj-mcp-fixture')).toBeUndefined();
  });
});
