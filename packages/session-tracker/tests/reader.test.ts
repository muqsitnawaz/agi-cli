import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// STATE_DIR is derived from os.homedir() at module load (state-file.ts), so the
// prune must run in a subprocess whose HOME is the test home — never the real one.
const readerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'reader.ts');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('pruneStaleSessionState', () => {
  it('removes dead-pid state files and hour-old atomic-write temps, keeps live state and fresh temps', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-reader-'));
    dirs.push(home);
    const stateDir = path.join(home, '.agents', '.cache', 'terminals', 'sessions');
    fs.mkdirSync(stateDir, { recursive: true });

    const deadPid = Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
    const livePid = process.pid;
    fs.writeFileSync(path.join(stateDir, `${deadPid}.json`), '{}');
    fs.writeFileSync(path.join(stateDir, `${livePid}.json`), '{}');
    // Both temp shapes: hook.sh's mktemp names and writeStateAtomic's .tmp names.
    const oldHookTemp = path.join(stateDir, '.777.abcdef');
    const oldTsTemp = path.join(stateDir, '777.json.888.1700000000000.tmp');
    const freshTemp = path.join(stateDir, '.777.fresh0');
    for (const p of [oldHookTemp, oldTsTemp, freshTemp]) fs.writeFileSync(p, '');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldHookTemp, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(oldTsTemp, twoHoursAgo, twoHoursAgo);

    const script = `
      const { pruneStaleSessionState } = await import(${JSON.stringify(readerPath)});
      console.log(JSON.stringify({ removed: await pruneStaleSessionState() }));
    `;
    const out = spawnSync('bun', ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toEqual({ removed: 3 });
    expect(fs.existsSync(path.join(stateDir, `${deadPid}.json`))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, `${livePid}.json`))).toBe(true);
    expect(fs.existsSync(oldHookTemp)).toBe(false);
    expect(fs.existsSync(oldTsTemp)).toBe(false);
    expect(fs.existsSync(freshTemp)).toBe(true);
  });
});
