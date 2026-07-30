/**
 * `agents export` — copy an ISOLATED install's config back out to the user's real
 * `~/.<agent>`, so they can keep their settings and delete agents-cli entirely.
 *
 * Isolation is currently a one-way door: `agents add <agent>@<v> --isolated` builds a
 * self-contained home under the version dir, and nothing ever brings that work back.
 * Reversibility is what makes a sandbox safe to try.
 *
 * Three modes, because "export" means different things depending on which config you
 * consider authoritative:
 *
 *   merge (default) — additive. Copy only paths the user doesn't already have. A
 *                     collision is NOT silently skipped: the incoming file is written
 *                     beside theirs as `<name>.from-agents-cli` so they can diff and
 *                     take the parts they want. Nothing of theirs is ever modified.
 *   replace         — the isolated config becomes `~/.<agent>`; theirs moves to
 *                     `backups/<agent>/<ts>`. For when you've been living in the
 *                     sandbox and want to promote it wholesale.
 *   staged          — write the whole tree to `~/.<agent>/.agents-export-<ts>/` and
 *                     activate nothing. For inspecting first.
 *
 * Every mode leaves a receipt at `~/.<agent>/.agents-cli-export.json` recording what
 * came from the export. That is what makes provenance answerable ("which of these
 * files are mine?") and the whole operation reversible.
 *
 * Deliberately NOT implemented: key-level merging of file *contents*. The TOML
 * library here does not preserve comments across parse+stringify, so auto-merging a
 * `config.toml` would silently delete the user's comments. Handing over both files
 * and a diff is honest; rewriting their config behind a "merge" flag is not.
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

export type ExportMode = 'merge' | 'replace' | 'staged';

/** Filename of the provenance receipt written into the agent's config dir. */
export const RECEIPT_NAME = '.agents-cli-export.json';

/** Suffix for the incoming copy of a file the user already has. */
export const CONFLICT_SUFFIX = '.from-agents-cli';

/** Why an export cannot proceed. Each maps to a distinct user-facing remedy. */
export type ExportBlocker =
  | { kind: 'not-installed' }
  | { kind: 'not-isolated' }
  | { kind: 'no-config'; source: string }
  | { kind: 'dest-adopted'; realPath: string; adoptedVersion: string };

/** What the destination `~/.<agent>` currently is. */
export type DestKind = 'absent' | 'real-dir' | 'foreign-symlink';

/** One file the export would place, relative to the config dir root. */
export interface ExportEntry {
  /** Path relative to the config dir, e.g. `prompts/review.md`. */
  rel: string;
  /** Absolute source file inside the isolated home. */
  source: string;
  /** Absolute path this file will be written to. */
  target: string;
  /**
   * Set when the user already has `rel`. `target` then points at the
   * `.from-agents-cli` sibling, and `existing` is the untouched original.
   */
  existing?: string;
}

export interface ExportPlan {
  agent: AgentId;
  version: string;
  mode: ExportMode;
  /** The isolated config dir, e.g. `<versionDir>/home/.codex`. */
  source: string;
  /** The user's real config dir, e.g. `~/.codex`. */
  dest: string;
  destKind: DestKind;
  /** Files with no counterpart in `dest` — written in place. */
  writes: ExportEntry[];
  /** Files the user already has — written alongside, never over. */
  conflicts: ExportEntry[];
  /** replace mode only: where `dest` gets moved first. */
  backupPath: string | null;
  /** staged mode only: the subdirectory receiving the whole tree. */
  stagedPath: string | null;
  receiptPath: string;
  blocker: ExportBlocker | null;
}

export interface ExportResult {
  exported: boolean;
  dest: string;
  written: string[];
  conflicts: Array<{ path: string; theirs: string }>;
  backupPath: string | null;
  stagedPath: string | null;
  receiptPath: string | null;
  errors: string[];
}

/** The config dir's basename (`.codex`), used to locate it inside a version home. */
function configBasename(agent: AgentId): string {
  return path.basename(AGENTS[agent].configDir);
}

/**
 * Every regular file under `root`, as paths relative to it. Symlinks pointing back
 * into `~/.agents` are omitted for the same reason `copyDirStrippingAgentsSymlinks`
 * drops them: they dangle the moment `~/.agents` is disposed, and an export that
 * leaves dangling links is not an export.
 */
function walkFiles(root: string, agentsDir: string, rel = ''): string[] {
  const inside = agentsDir + path.sep;
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    const abs = path.join(root, childRel);
    if (entry.isSymbolicLink()) {
      try {
        const tgt = path.resolve(path.dirname(abs), fs.readlinkSync(abs));
        if (tgt === agentsDir || tgt.startsWith(inside)) continue;
      } catch {
        continue;
      }
      out.push(childRel);
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, agentsDir, childRel));
      continue;
    }
    out.push(childRel);
  }
  return out;
}

/** Build a read-only plan. Performs no mutations. */
export function planExport(
  agent: AgentId,
  version: string,
  timestamp: number,
  mode: ExportMode = 'merge',
): ExportPlan {
  const source = path.join(getVersionHomePath(agent, version), configBasename(agent));
  const dest = getAgentConfigPath(agent);

  const base: Omit<ExportPlan, 'blocker'> = {
    agent,
    version,
    mode,
    source,
    dest,
    destKind: 'absent',
    writes: [],
    conflicts: [],
    backupPath: null,
    stagedPath: null,
    receiptPath: path.join(dest, RECEIPT_NAME),
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

  const agentsDir = getUserAgentsDir();
  const rels = walkFiles(source, agentsDir).sort();

  if (mode === 'staged') {
    const stagedPath = path.join(dest, `.agents-export-${timestamp}`);
    return {
      ...base,
      destKind,
      stagedPath,
      writes: rels.map((rel) => ({
        rel,
        source: path.join(source, rel),
        target: path.join(stagedPath, rel),
      })),
      blocker: null,
    };
  }

  if (mode === 'replace') {
    return {
      ...base,
      destKind,
      backupPath: destKind === 'real-dir' ? path.join(getBackupsDir(), agent, String(timestamp)) : null,
      writes: rels.map((rel) => ({
        rel,
        source: path.join(source, rel),
        target: path.join(dest, rel),
      })),
      blocker: null,
    };
  }

  // merge: additive. Anything the user already has becomes a conflict written
  // alongside, so their file is never the thing that changes.
  const writes: ExportEntry[] = [];
  const conflicts: ExportEntry[] = [];
  for (const rel of rels) {
    const target = path.join(dest, rel);
    let exists = false;
    try {
      fs.lstatSync(target);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      conflicts.push({
        rel,
        source: path.join(source, rel),
        target: target + CONFLICT_SUFFIX,
        existing: target,
      });
    } else {
      writes.push({ rel, source: path.join(source, rel), target });
    }
  }
  return { ...base, destKind, writes, conflicts, blocker: null };
}

/** Copy one file, creating parent dirs. Symlinks are recreated, not followed. */
function placeFile(entry: ExportEntry): void {
  fs.mkdirSync(path.dirname(entry.target), { recursive: true });
  const st = fs.lstatSync(entry.source);
  if (st.isSymbolicLink()) {
    const link = fs.readlinkSync(entry.source);
    try {
      fs.unlinkSync(entry.target);
    } catch {
      /* nothing there */
    }
    fs.symlinkSync(link, entry.target);
    return;
  }
  fs.copyFileSync(entry.source, entry.target);
}

function writeReceipt(plan: ExportPlan, result: ExportResult, timestamp: number): void {
  const receipt = {
    exportedAt: new Date(timestamp).toISOString(),
    from: `${plan.agent}@${plan.version} (isolated)`,
    mode: plan.mode,
    written: result.written,
    conflicts: result.conflicts,
    ...(result.backupPath ? { backupPath: result.backupPath } : {}),
    ...(result.stagedPath ? { stagedAt: result.stagedPath } : {}),
    note:
      plan.mode === 'merge'
        ? `Files under "written" came from this export. Paths under "conflicts" already existed and were NOT modified — the incoming version sits beside yours with the ${CONFLICT_SUFFIX} suffix.`
        : plan.mode === 'replace'
          ? 'This config was replaced wholesale by the export; the previous one is at backupPath.'
          : 'Nothing was activated — the exported tree sits under stagedAt.',
  };
  fs.mkdirSync(path.dirname(plan.receiptPath), { recursive: true });
  fs.writeFileSync(plan.receiptPath, JSON.stringify(receipt, null, 2) + '\n');
}

/** Execute a plan from {@link planExport}. */
export function executeExport(plan: ExportPlan, timestamp: number): ExportResult {
  const result: ExportResult = {
    exported: false,
    dest: plan.dest,
    written: [],
    conflicts: [],
    backupPath: null,
    stagedPath: null,
    receiptPath: null,
    errors: [],
  };
  if (plan.blocker) {
    result.errors.push(`refusing to export: ${plan.blocker.kind}`);
    return result;
  }

  try {
    if (plan.mode === 'replace') {
      if (plan.backupPath) {
        fs.mkdirSync(path.dirname(plan.backupPath), { recursive: true });
        moveDirCrossDevice(plan.dest, plan.backupPath);
        result.backupPath = plan.backupPath;
      } else if (plan.destKind === 'foreign-symlink') {
        // Not ours to back up, but it must go or cpSync would write through it.
        fs.unlinkSync(plan.dest);
      }
      copyDirStrippingAgentsSymlinks(plan.source, plan.dest, getUserAgentsDir());
      result.written = plan.writes.map((w) => w.rel);
    } else {
      // merge and staged both place individual files; neither disturbs anything
      // the user already has.
      for (const entry of plan.writes) {
        placeFile(entry);
        result.written.push(entry.rel);
      }
      for (const entry of plan.conflicts) {
        placeFile(entry);
        result.conflicts.push({ path: entry.rel, theirs: entry.target });
      }
      if (plan.stagedPath) result.stagedPath = plan.stagedPath;
    }

    writeReceipt(plan, result, timestamp);
    result.receiptPath = plan.receiptPath;
    result.exported = true;
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }
  return result;
}
