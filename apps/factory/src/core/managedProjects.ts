// Curated project store — backed by canonical ~/.agents/projects/<name>.yaml
// definitions (the same files the `agents projects` CLI commands manage).
//
// Reads shell out to `agents projects list --json` so Factory and the CLI share
// one source of truth. Writes go directly to the YAML files (using the `yaml`
// package already in Factory's deps) so any CLI or UI tool sees changes immediately.
//
// On first run when the old ~/.agents/factory/projects.json exists but no YAML
// files do, readManagedProjects() auto-migrates, preserving dispatch metadata
// (autoDispatch/maxAgents) that the `import --from-factory` CLI command did not carry.

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import YAML from 'yaml';
import { runAgents, AgentsBinNotFoundError } from './agentsBin';

/** Mirror of cli/src/lib/projects.ts isSafeProjectName — no path separators or dot-escapes. */
function isSafeId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(id) &&
    id !== '.' &&
    id !== '..'
  );
}

/**
 * A curated project. The webview mirrors this shape field-for-field in
 * ui/settings/components/mission-control/floorModel.ts — keep them in sync.
 */
export interface ManagedProject {
  id: string;                                 // stable local id (= the project YAML slug)
  name: string;                               // label in sidebar + dispatch
  path: string;                               // absolute local folder
  repoSlug?: string;                          // "owner/repo"
  linearProjectId?: string;
  linearProjectName?: string;                 // for the Linear pill
  autoDispatch?: boolean;                     // opt-in: auto-pick delegated Todo tickets (default off)
  maxAgents?: number;                         // cap on concurrent auto-dispatched agents for this project
  confidence: 'high' | 'medium' | 'low';
  source: 'detected' | 'manual';
}

/** Canonical directory for project YAML definitions — mirrors CLI's getProjectsDir(). */
function projectsDir(): string {
  return process.env.AGENTS_PROJECTS_DIR ?? path.join(homedir(), '.agents', 'projects');
}

/** Path to the old Factory-owned projects registry (pre-migration). */
function oldFactoryProjectsPath(): string {
  return path.join(homedir(), '.agents', 'factory', 'projects.json');
}

/** Basename of a path, with any trailing slash ignored. Used by settings.vscode.ts. */
export function projectNameFromPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Map a ProjectDef JSON shape (from `agents projects list --json`) to a ManagedProject. */
export function defToManaged(def: Record<string, unknown>): ManagedProject {
  const name = typeof def.name === 'string' ? def.name : '';
  const rootRaw =
    typeof def.root === 'string' ? def.root : typeof def.defaultPath === 'string' ? def.defaultPath : '';
  const expandedPath = rootRaw.startsWith('~/')
    ? path.join(homedir(), rootRaw.slice(2))
    : rootRaw;
  const linear =
    def.linear && typeof def.linear === 'object' && !Array.isArray(def.linear)
      ? (def.linear as Record<string, unknown>)
      : undefined;
  const dispatch =
    def.dispatch && typeof def.dispatch === 'object' && !Array.isArray(def.dispatch)
      ? (def.dispatch as Record<string, unknown>)
      : undefined;
  const repos = Array.isArray(def.repos) ? (def.repos as Array<Record<string, unknown>>) : [];
  const repoSlug =
    typeof def.repo === 'string'
      ? def.repo
      : typeof repos[0]?.slug === 'string'
        ? repos[0].slug
        : undefined;
  return {
    id: name,
    name,
    path: expandedPath,
    repoSlug,
    linearProjectId: typeof linear?.projectId === 'string' ? linear.projectId : undefined,
    linearProjectName: typeof linear?.name === 'string' ? linear.name : undefined,
    autoDispatch: dispatch?.enabled === true,
    maxAgents: typeof dispatch?.maxAgents === 'number' ? dispatch.maxAgents : undefined,
    confidence: 'high',
    source: 'manual',
  };
}

/**
 * Build the YAML object for a project. Merges Factory-managed fields onto any
 * existing YAML content, preserving unmanaged fields (goals, contexts, etc.).
 */
async function buildProjectYaml(project: ManagedProject): Promise<Record<string, unknown>> {
  const filePath = path.join(projectsDir(), `${project.id}.yaml`);
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    /* new project — start empty */
  }

  existing.name = project.id;

  // Convert absolute path back to home-relative for portable YAML.
  const h = homedir();
  const homeRelPath =
    project.path && project.path.startsWith(h + '/')
      ? `~/${project.path.slice(h.length + 1)}`
      : project.path;
  if (homeRelPath) existing.root = homeRelPath;
  else delete existing.root;

  if (project.repoSlug) existing.repo = project.repoSlug;
  else delete existing.repo;

  // linear block — preserve any existing url field
  const prevLinear =
    existing.linear && typeof existing.linear === 'object' && !Array.isArray(existing.linear)
      ? { ...(existing.linear as Record<string, unknown>) }
      : {};
  if (project.linearProjectId) prevLinear.projectId = project.linearProjectId;
  else delete prevLinear.projectId;
  if (project.linearProjectName) prevLinear.name = project.linearProjectName;
  else delete prevLinear.name;
  if (Object.keys(prevLinear).length > 0) existing.linear = prevLinear;
  else delete existing.linear;

  // dispatch block
  const prevDispatch =
    existing.dispatch && typeof existing.dispatch === 'object' && !Array.isArray(existing.dispatch)
      ? { ...(existing.dispatch as Record<string, unknown>) }
      : {};
  if (project.autoDispatch === true) prevDispatch.enabled = true;
  else delete prevDispatch.enabled;
  if (project.maxAgents !== undefined) prevDispatch.maxAgents = project.maxAgents;
  else delete prevDispatch.maxAgents;
  if (Object.keys(prevDispatch).length > 0) existing.dispatch = prevDispatch;
  else delete existing.dispatch;

  return existing;
}

/** Validate a project name — mirrors CLI's isSafeProjectName(). */
function isSafeName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

/**
 * One-time migration: copy rows from the old ~/.agents/factory/projects.json
 * to individual YAML files under ~/.agents/projects/. Preserves autoDispatch
 * and maxAgents fields that the `import --from-factory` CLI command did not carry.
 * Skips rows that already have a corresponding YAML file.
 */
async function migrateFromFactoryJson(): Promise<ManagedProject[]> {
  let rawText: string;
  try {
    rawText = await fs.promises.readFile(oldFactoryProjectsPath(), 'utf-8');
  } catch {
    return [];
  }
  let rows: unknown[];
  try {
    const parsed: unknown = JSON.parse(rawText);
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
  const dir = projectsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const migrated: ManagedProject[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : undefined;
    if (!name || !isSafeName(name)) continue;
    const yamlPath = path.join(dir, `${name}.yaml`);
    try {
      await fs.promises.access(yamlPath);
      continue; // already migrated
    } catch {
      /* file doesn't exist yet — create it */
    }
    const project: ManagedProject = {
      id: name,
      name,
      path: typeof o.path === 'string' ? o.path : '',
      repoSlug: typeof o.repoSlug === 'string' ? o.repoSlug : undefined,
      linearProjectId: typeof o.linearProjectId === 'string' ? o.linearProjectId : undefined,
      linearProjectName: typeof o.linearProjectName === 'string' ? o.linearProjectName : undefined,
      autoDispatch: o.autoDispatch === true,
      maxAgents: typeof o.maxAgents === 'number' ? o.maxAgents : undefined,
      confidence: 'high',
      source: 'manual',
    };
    const yaml = await buildProjectYaml(project);
    try {
      await fs.promises.writeFile(yamlPath, YAML.stringify(yaml));
      migrated.push(project);
    } catch {
      /* skip rows that can't be written */
    }
  }
  return migrated;
}

/**
 * Read the project list by shelling out to `agents projects list --json`.
 * On first run (no YAML projects yet, old factory JSON present) auto-migrates.
 * Returns [] when the CLI is unavailable or no projects are defined.
 */
export async function readManagedProjects(): Promise<ManagedProject[]> {
  try {
    const { stdout } = await runAgents('projects list --json');
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    const managed = parsed
      .filter((d) => d && typeof d === 'object' && typeof (d as Record<string, unknown>).name === 'string')
      .map((d) => defToManaged(d as Record<string, unknown>));
    // One-time migration: when no YAML projects exist yet but the legacy factory
    // JSON does, migrate it so the user's curated list isn't lost on upgrade.
    if (managed.length === 0) {
      const migrated = await migrateFromFactoryJson();
      if (migrated.length > 0) return readManagedProjects();
    }
    return managed;
  } catch (err) {
    if (err instanceof AgentsBinNotFoundError) {
      // CLI not found — fall back to migration so the first launch still works.
      return migrateFromFactoryJson();
    }
    return [];
  }
}

/** Add a new project or update an existing one (matched by id). Returns the new list. */
export async function upsertManagedProject(project: ManagedProject): Promise<ManagedProject[]> {
  if (!isSafeId(project.id)) throw new Error(`Unsafe project id: ${JSON.stringify(project.id)}`);
  const dir = projectsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const yaml = await buildProjectYaml(project);
  await fs.promises.writeFile(path.join(dir, `${project.id}.yaml`), YAML.stringify(yaml));
  return readManagedProjects();
}

/** Remove a project by id (deletes its YAML file). Returns the new list. */
export async function deleteManagedProject(id: string): Promise<ManagedProject[]> {
  if (!isSafeId(id)) throw new Error(`Unsafe project id: ${JSON.stringify(id)}`);
  try {
    await fs.promises.unlink(path.join(projectsDir(), `${id}.yaml`));
  } catch {
    /* already gone */
  }
  return readManagedProjects();
}
