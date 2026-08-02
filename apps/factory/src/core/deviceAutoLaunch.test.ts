import { test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadAutoLaunchPreferences, isAutoLaunchEnabled, isAutoLaunchPreferred } from './deviceAutoLaunch';

// The real file the CLI writes and this module reads. Tests drive the actual
// path (no mocked fs) and restore whatever was there.
const prefsPath = path.join(os.homedir(), '.agents', '.history', 'devices', 'auto-launch.json');
let saved: string | null = null;
let existedBefore = false;

function write(contents: string): void {
  if (saved === null) {
    existedBefore = fs.existsSync(prefsPath);
    saved = existedBefore ? fs.readFileSync(prefsPath, 'utf-8') : '';
  }
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, contents);
}

afterEach(() => {
  if (saved === null) return;
  if (existedBefore) fs.writeFileSync(prefsPath, saved);
  else fs.rmSync(prefsPath, { force: true });
  saved = null;
});

test('reads enable/prefer flags the CLI wrote', () => {
  write(JSON.stringify({ devices: { 'box-a': { enabled: false }, 'box-b': { preferred: true } } }));
  const prefs = loadAutoLaunchPreferences();
  expect(isAutoLaunchEnabled(prefs, 'box-a')).toBe(false);
  expect(isAutoLaunchPreferred(prefs, 'box-b')).toBe(true);
});

test('an unlisted device defaults to enabled and not preferred', () => {
  write(JSON.stringify({ devices: {} }));
  const prefs = loadAutoLaunchPreferences();
  expect(isAutoLaunchEnabled(prefs, 'never-seen')).toBe(true);
  expect(isAutoLaunchPreferred(prefs, 'never-seen')).toBe(false);
});

// Counterpart to the CLI-side test that pins the opposite behavior
// (apps/cli/src/lib/devices/auto-launch.test.ts: "throws on a corrupted file").
// The extension must keep launching; see the module doc for why they differ.
test('a corrupted file degrades to defaults rather than throwing', () => {
  write('{ not json at all');
  const prefs = loadAutoLaunchPreferences();
  expect(prefs).toEqual({});
  expect(isAutoLaunchEnabled(prefs, 'anything')).toBe(true);
});
