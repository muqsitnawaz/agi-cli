/**
 * `agents export` — copy an ISOLATED install's config back out to the user's real
 * `~/.<agent>`, so they can keep their settings and delete agents-cli entirely.
 *
 * Isolation is currently a one-way door: `agents add <agent>@<v> --isolated` builds a
 * self-contained home under the version dir, and nothing ever brings that work back.
 * A user who configures an isolated copy for a week and then wants it as their normal
 * setup has to copy files by hand. Reversibility is what makes a sandbox safe to try.
 *
 * Scope is deliberately isolated installs only. A NORMAL install's config dir is
 * already the user's `~/.<agent>` (adoption replaces it with a symlink into the
 * version home), so "exporting" one would copy a directory onto itself. `agents
 * uninstall` is the right tool there — it un-adopts.
 *
 * Split into a read-only {@link planExport} and a mutating {@link executeExport} so
 * `--dry-run` and the real run share one code path, mirroring `lib/uninstall.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

import { AGENTS } from './agents.js';
import type { AgentId } from './types.js';
import { getAgentConfigPath, getConfigSymlinkVersion } from './shims.js';
import { getVersionHomePath, isVersionIsolated, isVersionInstalled } from './versions.js';
import { getUserAgentsDir, getBackupsDir } from './state.js';
import { copyDirStrippingAgentsSymlinks, moveDirCrossDevice } from './config-transfer.js';

/** Why an export cannot proceed. Each maps to a distinct user-facing remedy. */
export type ExportBlocker =
  | { kind: 'not-installed' }
  | { kind: 'not-isolated' }
  | { kind: 'no-config'; source: string }
  | { kind: 'dest-adopted'; realPath: string; adoptedVersion: string };

/** What the destination `~/.<agent>` currently is. Decides whether we back it up. */
export type DestKind = 'absent' | 'real-dir' | 'foreign-symlink';

/** Read-only description of what an export would change. */
export interface ExportPlan {
  agent: AgentId;
  version: string;
  /** The isolated config dir, e.g. `<versionDir>/home/.codex`. */
  source: string;
  /** The user's real config dir, e.g. `~/.codex`. */
  dest: string;
  destKind: DestKind;
  /** Where `dest` gets moved before being replaced, or null when nothing is there. */
  backupPath: string | null;
  /** Top-level entry names being exported — enough to show without walking the tree. */
  entries: string[];
  blocker: ExportBlocker | null;
}

export interface ExportResult {
  exported: boolean;
  dest: string;
  backupPath: string | null;
  errors: string[];
}

/** The config dir's basename (`.codex`), used to locate it inside a version home. */
function configBasename(agent: AgentId): string {
  return path.basename(AGENTS[agent].configDir);
}

/**
 * Build a read-only plan. Performs no mutations, so `--dry-run` prints exactly what
 * the real run would do.
 */
export function planExport(agent: AgentId, version: string, timestamp: number): ExportPlan {
  const source = path.join(getVersionHomePath(agent, version), configBasename(agent));
  const dest = getAgentConfigPath(agent);

  const base: Omit<ExportPlan, 'blocker'> = {
    agent,
    version,
    source,
    dest,
    destKind: 'absent',
    backupPath: null,
    entries: [],
  };

  if (!isVersionInstalled(agent, version)) return { ...base, blocker: { kind: 'not-installed' } };
  if (!isVersionIsolated(agent, version)) return { ...base, blocker: { kind: 'not-isolated' } };
  if (!fs.existsSync(source)) return { ...base, blocker: { kind: 'no-config', source } };

  // Refuse when `~/.<agent>` is a symlink agents-cli owns: the agent has a normal
  // install that adopted it, so writing there would land inside a version home
  // rather than in the user's real config, and silently mutate that other install.
  const adopted = getConfigSymlinkVersion(agent);
  if (adopted !== null) {
    return { ...base, blocker: { kind: 'dest-adopted', realPath: dest, adoptedVersion: adopted } };
  }

  let destKind: DestKind = 'absent';
  try {
    destKind = fs.lstatSync(dest).isSymbolicLink() ? 'foreign-symlink' : 'real-dir';
  } catch {
    destKind = 'absent';
  }

  // Only a real directory is ours to move aside. A foreign symlink belongs to some
  // other tool; replacing it silently would be a surprise, so it is surfaced and
  // requires the caller to decide.
  const backupPath =
    destKind === 'real-dir' ? path.join(getBackupsDir(), agent, String(timestamp)) : null;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(source).sort();
  } catch {
    entries = [];
  }

  return { ...base, destKind, backupPath, entries, blocker: null };
}

/**
 * Execute a plan from {@link planExport}: move any existing real config aside, then
 * copy the isolated config out with `~/.agents` symlinks stripped so the result keeps
 * working after agents-cli is gone.
 */
export function executeExport(plan: ExportPlan): ExportResult {
  const result: ExportResult = { exported: false, dest: plan.dest, backupPath: null, errors: [] };
  if (plan.blocker) {
    result.errors.push(`refusing to export: ${plan.blocker.kind}`);
    return result;
  }

  try {
    if (plan.backupPath) {
      fs.mkdirSync(path.dirname(plan.backupPath), { recursive: true });
      moveDirCrossDevice(plan.dest, plan.backupPath);
      result.backupPath = plan.backupPath;
    } else if (plan.destKind === 'foreign-symlink') {
      // Not ours to back up, but it must go or cpSync would write through it.
      fs.unlinkSync(plan.dest);
    }
    copyDirStrippingAgentsSymlinks(plan.source, plan.dest, getUserAgentsDir());
    result.exported = true;
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }
  return result;
}
