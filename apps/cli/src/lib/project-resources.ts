import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import { AGENTS } from './agents.js';
import type { AgentId, ManifestHook, ProjectScopedResourceKind } from './types.js';
import { supportsProjectScope } from './capabilities.js';
import { getEnabledExtraRepos, getProjectAgentsDir, getSystemAgentsDir, getUserAgentsDir } from './state.js';
import { safeJoin } from './paths.js';
import { markdownToToml } from './convert.js';
import { commandAppliesTo, parseCommandMetadata } from './commands.js';
import { registerHooksToSettings, type HookEntry } from './hooks.js';
import { getMcpServersByName, writeMcpConfig, writeMcpConfigSupportsAgent, type WritableMcpServer } from './mcp.js';
import { transformSubagentForOpenCode } from './subagents.js';
import { subagentTarget } from './subagents-registry.js';

const MANIFEST_FILE = '.agents-cli-manifest.json';
const COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);
const NON_SCRIPT_EXTENSIONS = new Set(['.md', '.markdown', '.rst', '.txt', '.yaml', '.yml', '.json', '.toml', '.ini', '.conf']);
const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.ts', '.mjs', '.cjs', '.rb', '.pl', '.ps1', '.cmd', '.bat']);

type ManagedKind = ProjectScopedResourceKind;

interface ProjectResourceManifest {
  v: 1;
  agent: AgentId;
  version: string;
  managed: Partial<Record<ManagedKind, Record<string, string[]>>>;
}

const PROJECT_CONFIG_DIR: Partial<Record<AgentId, string>> = {
  claude: '.claude',
  codex: '.codex',
  gemini: '.gemini',
  cursor: '.cursor',
  opencode: '.opencode',
};

export function projectAgentDir(cwd: string, agent: AgentId): string {
  return path.join(cwd, PROJECT_CONFIG_DIR[agent] ?? `.${agent}`);
}

function manifestPath(cwd: string, agent: AgentId): string {
  return path.join(projectAgentDir(cwd, agent), MANIFEST_FILE);
}

function readManifest(cwd: string, agent: AgentId): ProjectResourceManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(cwd, agent), 'utf-8')) as ProjectResourceManifest;
    if (raw.v === 1 && raw.agent === agent && raw.managed && typeof raw.managed === 'object') return raw;
  } catch { /* missing or invalid manifest */ }
  return { v: 1, agent, version: '', managed: {} };
}

function writeManifest(cwd: string, agent: AgentId, manifest: ProjectResourceManifest): void {
  const p = manifestPath(cwd, agent);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8');
}

function removePath(p: string): void {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(p);
    else if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  } catch { /* already absent */ }
}

function relativeToProjectDir(cwd: string, agent: AgentId, p: string): string {
  return path.relative(projectAgentDir(cwd, agent), p);
}

function cleanupRemoved(cwd: string, agent: AgentId, previous: ProjectResourceManifest, next: ProjectResourceManifest): void {
  const base = projectAgentDir(cwd, agent);
  for (const kind of Object.keys(previous.managed) as ManagedKind[]) {
    const oldEntries = previous.managed[kind] ?? {};
    const newEntries = next.managed[kind] ?? {};
    for (const [name, rels] of Object.entries(oldEntries)) {
      if (newEntries[name]) continue;
      for (const rel of rels) {
        const target = path.resolve(base, rel);
        if (target === base || target.startsWith(base + path.sep)) removePath(target);
      }
    }
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || COPY_IGNORE.has(entry.name)) continue;
    const s = safeJoin(src, entry.name);
    const d = safeJoin(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function listProjectHookEntries(dir: string): HookEntry[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .map((file) => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      return {
        name: file,
        base: path.basename(file, path.extname(file)),
        ext: path.extname(file).toLowerCase(),
        fullPath,
        isFile: stat.isFile(),
        isExec: (stat.mode & 0o111) !== 0,
      };
    })
    .filter((file) => file.isFile);
  const grouped = new Map<string, typeof files>();
  for (const file of files) grouped.set(file.base, [...(grouped.get(file.base) ?? []), file]);
  const out: HookEntry[] = [];
  for (const [base, group] of grouped) {
    const script = group.find((f) => SCRIPT_EXTENSIONS.has(f.ext)) || group.find((f) => f.isExec && !NON_SCRIPT_EXTENSIONS.has(f.ext));
    if (!script) continue;
    const data = group.find((f) => f !== script && !['.md', '.markdown', '.rst'].includes(f.ext));
    out.push({ name: script.name, scriptPath: script.fullPath, dataFile: data?.fullPath });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function projectSource(cwd: string, kind: ManagedKind, name: string): string | null {
  const projectDir = getProjectAgentsDir(cwd);
  if (!projectDir) return null;
  const dir = path.join(projectDir, kind);
  if (kind === 'commands') {
    const p = path.join(dir, `${name}.md`);
    return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
  }
  if (kind === 'skills' || kind === 'subagents') {
    const marker = kind === 'skills' ? 'SKILL.md' : 'AGENT.md';
    const p = path.join(dir, name);
    return fs.existsSync(path.join(p, marker)) ? p : null;
  }
  if (kind === 'mcp') {
    for (const ext of ['.yaml', '.yml']) {
      const p = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  }
  if (kind === 'hooks') {
    for (const entry of listProjectHookEntries(dir)) {
      if (entry.name === name) return entry.scriptPath;
    }
  }
  return null;
}

function trustedSourceExists(kind: ManagedKind, name: string): boolean {
  const bases = [getUserAgentsDir(), getSystemAgentsDir(), ...getEnabledExtraRepos().map((e) => e.dir)];
  for (const base of bases) {
    if (kind === 'commands' && fs.existsSync(path.join(base, 'commands', `${name}.md`))) return true;
    if (kind === 'skills' && fs.existsSync(path.join(base, 'skills', name, 'SKILL.md'))) return true;
    if (kind === 'subagents' && fs.existsSync(path.join(base, 'subagents', name, 'AGENT.md'))) return true;
    if (kind === 'mcp' && (fs.existsSync(path.join(base, 'mcp', `${name}.yaml`)) || fs.existsSync(path.join(base, 'mcp', `${name}.yml`)))) return true;
    if (kind === 'hooks') {
      const entries = listProjectHookEntries(path.join(base, 'hooks'));
      if (entries.some((e) => e.name === name)) return true;
    }
  }
  return false;
}

function projectResourceMayMaterialize(cwd: string, kind: Exclude<ManagedKind, 'mcp'>, name: string): boolean {
  return !!projectSource(cwd, kind, name) && trustedSourceExists(kind, name);
}

export function filterVersionHomeSelection(
  kind: ManagedKind,
  names: string[],
  cwd: string,
  agent: AgentId,
  version: string,
): string[] {
  if (!supportsProjectScope(agent, kind, version).ok) return names;
  return names.filter((name) => !projectSource(cwd, kind, name) || trustedSourceExists(kind, name));
}

function addManaged(manifest: ProjectResourceManifest, kind: ManagedKind, name: string, files: string[]): void {
  manifest.managed[kind] ??= {};
  manifest.managed[kind]![name] = files;
}

function composeCommands(cwd: string, agent: AgentId, version: string, names: string[], manifest: ProjectResourceManifest): string[] {
  if (!supportsProjectScope(agent, 'commands', version).ok) return [];
  const cfg = AGENTS[agent];
  const ext = cfg.format === 'toml' ? '.toml' : '.md';
  const targetDir = path.join(projectAgentDir(cwd, agent), cfg.commandsSubdir || 'commands');
  const synced: string[] = [];
  for (const name of names) {
    const src = projectSource(cwd, 'commands', name);
    if (!src) continue;
    if (!projectResourceMayMaterialize(cwd, 'commands', name)) continue;
    const metadata = parseCommandMetadata(src);
    if (!commandAppliesTo(agent, version, metadata).ok) continue;
    fs.mkdirSync(targetDir, { recursive: true });
    const dest = safeJoin(targetDir, `${name}${ext}`);
    const content = fs.readFileSync(src, 'utf-8');
    fs.writeFileSync(dest, cfg.format === 'toml' ? markdownToToml(name, content) : content);
    addManaged(manifest, 'commands', name, [relativeToProjectDir(cwd, agent, dest)]);
    synced.push(name);
  }
  return synced;
}

function composeSkills(cwd: string, agent: AgentId, version: string, names: string[], manifest: ProjectResourceManifest): string[] {
  if (!supportsProjectScope(agent, 'skills', version).ok) return [];
  const targetRoot = path.join(projectAgentDir(cwd, agent), 'skills');
  const synced: string[] = [];
  for (const name of names) {
    const src = projectSource(cwd, 'skills', name);
    if (!src) continue;
    if (!projectResourceMayMaterialize(cwd, 'skills', name)) continue;
    const dest = safeJoin(targetRoot, name);
    removePath(dest);
    copyDir(src, dest);
    addManaged(manifest, 'skills', name, [relativeToProjectDir(cwd, agent, dest)]);
    synced.push(name);
  }
  return synced;
}

function readProjectHookManifest(cwd: string): Record<string, ManifestHook> {
  const projectDir = getProjectAgentsDir(cwd);
  if (!projectDir) return {};
  try {
    const parsed = yaml.parse(fs.readFileSync(path.join(projectDir, 'agents.yaml'), 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
    return parsed?.hooks ?? {};
  } catch {
    return {};
  }
}

function composeHooks(cwd: string, agent: AgentId, version: string, names: string[], manifest: ProjectResourceManifest): string[] {
  if (!supportsProjectScope(agent, 'hooks', version).ok) return [];
  const projectDir = getProjectAgentsDir(cwd);
  if (!projectDir) return [];
  const sourceDir = path.join(projectDir, 'hooks');
  const entries = new Map(listProjectHookEntries(sourceDir).map((e) => [e.name, e]));
  const targetDir = path.join(projectAgentDir(cwd, agent), AGENTS[agent].hooksDir || 'hooks');
  const synced: string[] = [];
  for (const name of names) {
    const entry = entries.get(name);
    if (!entry) continue;
    if (!projectResourceMayMaterialize(cwd, 'hooks', name)) continue;
    fs.mkdirSync(targetDir, { recursive: true });
    const written: string[] = [];
    const scriptDest = safeJoin(targetDir, path.basename(entry.scriptPath));
    fs.copyFileSync(entry.scriptPath, scriptDest);
    fs.chmodSync(scriptDest, fs.statSync(entry.scriptPath).mode | 0o755);
    written.push(relativeToProjectDir(cwd, agent, scriptDest));
    if (entry.dataFile) {
      const dataDest = safeJoin(targetDir, path.basename(entry.dataFile));
      fs.copyFileSync(entry.dataFile, dataDest);
      written.push(relativeToProjectDir(cwd, agent, dataDest));
    }
    addManaged(manifest, 'hooks', name, written);
    synced.push(name);
  }
  const hookManifest = readProjectHookManifest(cwd);
  const syncedSet = new Set(synced);
  const selectedHookManifest = Object.fromEntries(
    Object.entries(hookManifest).filter(([name, hook]) => syncedSet.has(name) || syncedSet.has(hook.script))
  );
  if (Object.keys(selectedHookManifest).length > 0) {
    registerHooksToSettings(agent, cwd, selectedHookManifest, projectDir);
  }
  return synced;
}

function composeSubagents(cwd: string, agent: AgentId, version: string, names: string[], manifest: ProjectResourceManifest): string[] {
  if (!supportsProjectScope(agent, 'subagents', version).ok) return [];
  if (agent === 'opencode') {
    const dir = path.join(cwd, '.opencode', 'agents');
    const synced: string[] = [];
    for (const name of names) {
      const src = projectSource(cwd, 'subagents', name);
      if (!src) continue;
      if (!projectResourceMayMaterialize(cwd, 'subagents', name)) continue;
      fs.mkdirSync(dir, { recursive: true });
      const dest = safeJoin(dir, `${name}.md`);
      fs.writeFileSync(dest, transformSubagentForOpenCode(src));
      addManaged(manifest, 'subagents', name, [relativeToProjectDir(cwd, agent, dest)]);
      synced.push(name);
    }
    return synced;
  }
  const target = subagentTarget(agent);
  if (!target) return [];
  const home = cwd;
  const dir = target.dir(home);
  const synced: string[] = [];
  for (const name of names) {
    const src = projectSource(cwd, 'subagents', name);
    if (!src) continue;
    if (!projectResourceMayMaterialize(cwd, 'subagents', name)) continue;
    target.write(dir, { name, path: src });
    addManaged(manifest, 'subagents', name, target.occupied(dir, name).map((e) => relativeToProjectDir(cwd, agent, e.path)));
    synced.push(name);
  }
  return synced;
}

function removeMcpEntries(agent: AgentId, cwd: string, names: string[]): void {
  if (names.length === 0) return;
  const configPath = agent === 'claude'
    ? path.join(cwd, '.mcp.json')
    : agent === 'opencode'
      ? path.join(cwd, '.opencode', 'opencode.jsonc')
      : path.join(projectAgentDir(cwd, agent), agent === 'codex' ? 'config.toml' : agent === 'cursor' ? 'mcp.json' : 'settings.json');
  if (!fs.existsSync(configPath)) return;
  const nameSet = new Set(names);
  try {
    if (agent === 'codex') {
      const parsed = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
      if (servers && typeof servers === 'object') for (const n of nameSet) delete servers[n];
      fs.writeFileSync(configPath, TOML.stringify(parsed), 'utf-8');
      return;
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')) as Record<string, unknown>;
    const key = agent === 'opencode' ? 'mcp' : 'mcpServers';
    const servers = parsed[key] as Record<string, unknown> | undefined;
    if (servers && typeof servers === 'object') for (const n of nameSet) delete servers[n];
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
  } catch { /* preserve user config on parse/write errors */ }
}

function composeMcp(cwd: string, agent: AgentId, version: string, names: string[], previous: ProjectResourceManifest, manifest: ProjectResourceManifest): string[] {
  if (!supportsProjectScope(agent, 'mcp', version).ok || !writeMcpConfigSupportsAgent(agent)) return [];
  const projectNames = names.filter((name) => !!projectSource(cwd, 'mcp', name));
  const previousNames = Object.keys(previous.managed.mcp ?? {});
  removeMcpEntries(agent, cwd, previousNames.filter((name) => !projectNames.includes(name)));
  const servers = getMcpServersByName(projectNames, { cwd, enforceProjectTrust: true })
    .filter((server) => server.scope === 'project')
    .map((server): WritableMcpServer => ({
      name: server.config.name,
      transport: server.config.transport,
      command: server.config.command,
      args: server.config.args,
      env: server.config.env,
      url: server.config.url,
    }));
  if (servers.length === 0) return [];
  const configPath = agent === 'claude'
    ? path.join(cwd, '.mcp.json')
    : agent === 'opencode'
      ? path.join(cwd, '.opencode', 'opencode.jsonc')
      : path.join(projectAgentDir(cwd, agent), agent === 'codex' ? 'config.toml' : agent === 'cursor' ? 'mcp.json' : 'settings.json');
  writeMcpConfig(agent, configPath, servers, 'merge');
  for (const server of servers) addManaged(manifest, 'mcp', server.name, [path.relative(projectAgentDir(cwd, agent), configPath)]);
  return servers.map((s) => s.name);
}

export interface ComposeProjectResourcesResult {
  commands: string[];
  skills: string[];
  hooks: string[];
  subagents: string[];
  mcp: string[];
}

export function composeProjectResources(
  cwd: string,
  agent: AgentId,
  version: string,
  selection: Partial<Record<ManagedKind, string[]>>,
): ComposeProjectResourcesResult {
  const previous = readManifest(cwd, agent);
  const next: ProjectResourceManifest = { v: 1, agent, version, managed: {} };
  const result: ComposeProjectResourcesResult = { commands: [], skills: [], hooks: [], subagents: [], mcp: [] };
  result.commands = composeCommands(cwd, agent, version, selection.commands ?? [], next);
  result.skills = composeSkills(cwd, agent, version, selection.skills ?? [], next);
  result.hooks = composeHooks(cwd, agent, version, selection.hooks ?? [], next);
  result.subagents = composeSubagents(cwd, agent, version, selection.subagents ?? [], next);
  result.mcp = composeMcp(cwd, agent, version, selection.mcp ?? [], previous, next);
  cleanupRemoved(cwd, agent, previous, next);
  if (Object.values(next.managed).some((entries) => entries && Object.keys(entries).length > 0)) {
    writeManifest(cwd, agent, next);
  } else {
    removePath(manifestPath(cwd, agent));
  }
  return result;
}
