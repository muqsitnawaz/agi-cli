// Watchdog tail reader: locate a session transcript from its id + agent and
// pull the last N raw JSONL lines. The raw lines feed the pure detectors in
// watchdog.ts (isLikelyTrulyBlocked / renderWatchdogPrompt) and the pure
// summarizer in watchdogTail.ts.
//
// Adapted from Swarmify's readTailLines (extension/src/vscode/sessions.vscode.ts)
// to agents-cli's session layout. Path resolution REUSES getAgentSessionDirs()
// from src/lib/session/discover.ts — the same resolver the rest of the CLI uses
// to enumerate per-version transcript roots — instead of hardcoding
// ~/.agents/.history/versions/<agent>/.../projects/<enc>/<sessionId>.jsonl.

import * as fs from 'fs';
import * as path from 'path';
import { getAgentSessionDirs } from '../session/discover.js';

/** Default watchdog thresholds, mirrored from the Swarmify VS Code runtime. */
export const WATCHDOG_TAIL_LINES = 20;
export const WATCHDOG_STALL_MS = 300_000; // 5m — stallSeconds default
export const WATCHDOG_COOLDOWN_MS = 1_200_000; // 20m — cooldownSeconds default
export const WATCHDOG_DORMANT_MS = 3_600_000; // 1h — DORMANT_MS

const CHUNK_SIZE = 64 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Read the last `maxLines` non-empty lines of a JSONL transcript by seeking
 * backward from EOF in 64KB chunks. A tail that begins mid-line yields one
 * malformed leading line, which the callers' per-line JSON try/catch tolerates.
 * Returns `[]` on any read error or empty file.
 */
export function readTailLines(filePath: string, maxLines: number): string[] {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }

  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize === 0) return [];

    let position = fileSize;
    let buffer = '';
    let collected: string[] = [];

    while (position > 0 && collected.length <= maxLines) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      buffer = chunk.toString('utf-8') + buffer;
      collected = buffer.split(/\r?\n/).filter((l) => l.trim());
    }

    return collected.slice(-maxLines);
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd already gone */
    }
  }
}

/**
 * Given candidate transcript-root directories, find the JSONL file for a
 * session. Handles both the flat Claude layout (`<sessionId>.jsonl` inside a
 * per-project `<enc>/` subfolder) and Codex-style names that merely embed the
 * uuid (`rollout-…-<sessionId>.jsonl`). One level of per-project subdirs is
 * scanned. Newest mtime wins when a uuid appears in more than one root (e.g.
 * across version homes). Pure over its `dirs` argument, so it is testable
 * without touching the real home directory.
 */
export function findSessionJsonlIn(dirs: string[], sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  let best: { file: string; mtime: number } | undefined;

  const consider = (file: string): void => {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    if (!best || mtime > best.mtime) best = { file, mtime };
  };

  const matches = (name: string): boolean => {
    if (!name.endsWith('.jsonl')) return false;
    const stem = name.slice(0, -'.jsonl'.length);
    if (stem === sessionId) return true;
    // Codex embeds the uuid in a longer filename (rollout-<ts>-<uuid>.jsonl).
    return name.includes(sessionId) || (UUID_RE.test(sessionId) && stem.includes(sessionId));
  };

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Per-project subfolder (Claude `<enc>/`, Codex date partitions).
        let sub: string[];
        try {
          sub = fs.readdirSync(full);
        } catch {
          continue;
        }
        for (const name of sub) {
          if (matches(name)) consider(path.join(full, name));
        }
      } else if (entry.isFile() && matches(entry.name)) {
        consider(full);
      }
    }
  }

  return best?.file;
}

/**
 * Resolve a session transcript path from its id + agent, reusing the CLI's
 * per-version transcript roots. Returns `undefined` if no transcript is found.
 */
export function resolveWatchdogSessionPath(sessionId: string, agent: string): string | undefined {
  // Claude/Gemini keep per-project transcript folders under `projects/`;
  // Codex date-partitions rollouts under `sessions/`. Search both so the
  // resolver is agent-agnostic.
  const subdir = agent === 'codex' ? 'sessions' : 'projects';
  const dirs = getAgentSessionDirs(agent, subdir);
  return findSessionJsonlIn(dirs, sessionId);
}

/**
 * Read the last `maxLines` JSONL lines for a session by id + agent. Returns
 * `[]` when the transcript cannot be located or read.
 */
export function readWatchdogTail(
  sessionId: string,
  agent: string,
  maxLines: number = WATCHDOG_TAIL_LINES,
): string[] {
  const filePath = resolveWatchdogSessionPath(sessionId, agent);
  if (!filePath) return [];
  return readTailLines(filePath, maxLines);
}
