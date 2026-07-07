import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickSessionFile } from './active';

// Regression for the "every co-located session shows the same preview" bug: when a
// concrete session id was requested but its transcript file was absent,
// findClaudeSessionFile fell through to the NEWEST .jsonl in the cwd, so N distinct
// sessions collapsed onto one file's preview + topic (they looked like duplicate
// cards). A supplied-but-missing id must resolve to undefined, never a sibling.

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickfile-'));
  // Two real transcripts; make `b` strictly newer so it is the mtime winner.
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), '{"b":1}\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, 'a.jsonl'), old, old);
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('pickSessionFile', () => {
  test('a concrete id returns its own file', () => {
    expect(pickSessionFile(dir, 'a')).toBe(path.join(dir, 'a.jsonl'));
    expect(pickSessionFile(dir, 'b')).toBe(path.join(dir, 'b.jsonl'));
  });

  test('a supplied-but-missing id returns undefined — NOT the newest sibling', () => {
    // This is the fix: pre-fix this returned b.jsonl (the newest), so every
    // co-located session with an unresolved id shared b.jsonl's preview + topic.
    expect(pickSessionFile(dir, 'does-not-exist')).toBeUndefined();
  });

  test('two distinct missing ids do NOT collapse onto the same file', () => {
    const one = pickSessionFile(dir, 'ghost-1');
    const two = pickSessionFile(dir, 'ghost-2');
    expect(one).toBeUndefined();
    expect(two).toBeUndefined();
    // Neither borrowed the newest file, so they can't render an identical preview.
  });

  test('no id falls back to the newest file (legitimate single-session heuristic)', () => {
    expect(pickSessionFile(dir, undefined)).toBe(path.join(dir, 'b.jsonl'));
  });

  test('an unreadable project dir returns undefined', () => {
    expect(pickSessionFile(path.join(dir, 'nope'), undefined)).toBeUndefined();
  });
});
