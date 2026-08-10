import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { LinearProjectLite } from '../core/linearProjects';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const LINEAR_CONFIG = path.join(
  process.env.HOME || '',
  '.linear-cli/config.json'
);

let cachedLinearPath: string | null = null;

async function findLinearCli(): Promise<string | null> {
  if (cachedLinearPath !== null) return cachedLinearPath || null;
  try {
    const { stdout } = await execAsync('which linear');
    cachedLinearPath = stdout.trim();
    return cachedLinearPath || null;
  } catch {
    cachedLinearPath = '';
    return null;
  }
}

export async function isLinearAvailable(_context: vscode.ExtensionContext): Promise<boolean> {
  try {
    const linearPath = await findLinearCli();
    if (!linearPath) return false;
    await execFileAsync(linearPath, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the workspace's Linear projects via `linear projects --json`. Returns a
 * lightweight {id, name}[] to populate the add-project Linear dropdown. Degrades
 * to [] when the CLI is missing/unavailable — the UI shows "unavailable" and the
 * feature still works history-only.
 */
export async function fetchLinearProjects(context: vscode.ExtensionContext): Promise<LinearProjectLite[]> {
  if (!(await isLinearAvailable(context))) return [];
  try {
    const linearPath = await findLinearCli();
    if (!linearPath) return [];
    const { stdout } = await execFileAsync(linearPath, ['projects', '--json'], { timeout: 15000 });
    const parsed = JSON.parse(stdout);
    // `linear projects --json` returns a bare array; tolerate a {projects:[...]} wrapper too.
    const rows: any[] = Array.isArray(parsed) ? parsed : (parsed?.projects ?? []);
    return rows
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({ id: p.id, name: p.name }));
  } catch (err) {
    console.error('[LINEAR] Error fetching projects:', err);
    return [];
  }
}

export async function saveLinearApiKey(key: string): Promise<void> {
  let config: Record<string, any> = {};
  try {
    const raw = await fs.promises.readFile(LINEAR_CONFIG, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    // No existing config
  }
  config.apiKey = key;
  await fs.promises.mkdir(path.dirname(LINEAR_CONFIG), { recursive: true });
  await fs.promises.writeFile(LINEAR_CONFIG, JSON.stringify(config, null, 2));
}

export function clearLinearCache(): void {
  // No cache to clear with CLI approach
}
