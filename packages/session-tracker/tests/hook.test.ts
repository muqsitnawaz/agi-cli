import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook.sh');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionStart hook launch metadata', () => {
  it.each(['codex', 'kimi', 'droid'])('atomically joins the effective run mode to a %s session id', (agent) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const history = path.join(root, 'history');
    fs.mkdirSync(home);

    const result = spawnSync(hookPath, [agent], {
      input: JSON.stringify({ session_id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897', cwd: '/repo' }),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        AGENTS_HISTORY_DIR: history,
        AGENTS_RUN_MODE: 'edit',
        AGENTS_ACTOR: 'muqsit',
        AGENTS_ACTOR_KIND: 'human',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(history, 'by-session', '019fd0c8-b3e9-77a2-a1a4-444698c4d897.json'), 'utf8'))).toMatchObject({
      sessionId: '019fd0c8-b3e9-77a2-a1a4-444698c4d897',
      mode: 'edit',
      actor: 'muqsit',
      initiatedBy: 'human',
    });
  });

  it('joins the tmux wrapper alias to a harness-native session id without losing mode metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const history = path.join(root, 'history');
    const sessionId = '019fd114-4689-7df1-963f-ce06e5a36aeb';
    fs.mkdirSync(home);
    const result = spawnSync(hookPath, ['codex'], {
      input: JSON.stringify({ session_id: sessionId, cwd: '/repo' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENTS_HISTORY_DIR: history, AGENTS_RUN_MODE: 'edit', AGENT_TMUX_SESSION_NAME: 'ag-codex-c1f3d813' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(history, 'by-session', `${sessionId}.json`), 'utf8'))).toMatchObject({
      sessionId,
      mode: 'edit',
      aliases: ['ag-codex-c1f3d813'],
    });
  });

  it('writes the state file when invoked with no agent argument (the agents-cli managed registration)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const sessionId = '019fd200-0000-7000-8000-000000000001';

    // Manifest hook commands carry no argument; the hook must self-identify
    // (parent-process probe) and still record the session via the generic
    // stdin parse. The hook's $PPID is this test process.
    const result = spawnSync(hookPath, [], {
      input: JSON.stringify({ session_id: sessionId, cwd: '/repo' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(''); // SessionStart stdout leaks into model context
    const stateFile = path.join(home, '.agents', '.cache', 'terminals', 'sessions', `${process.pid}.json`);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state).toMatchObject({ session_id: sessionId, cwd: '/repo', pid: process.pid });
    expect(typeof state.agent).toBe('string');
    expect(state.agent.length).toBeGreaterThan(0);
  });

  it('prunes dead-pid state files and hour-old temps after a successful write', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const stateDir = path.join(home, '.agents', '.cache', 'terminals', 'sessions');
    fs.mkdirSync(stateDir, { recursive: true });

    // A pid that has provably exited.
    const deadPid = Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
    fs.writeFileSync(path.join(stateDir, `${deadPid}.json`), '{"session_id":"x","cwd":"/","pid":1,"ts":1}');
    // Pid 1 (launchd/init) is alive but not ours — EPERM must be left alone.
    fs.writeFileSync(path.join(stateDir, '1.json'), '{"session_id":"x","cwd":"/","pid":1,"ts":1}');
    // Orphaned atomic-write temps: an hour-old one goes, a fresh one stays.
    const oldTemp = path.join(stateDir, '.12345.abcdef');
    const freshTemp = path.join(stateDir, '.12345.fresh0');
    fs.writeFileSync(oldTemp, '');
    fs.writeFileSync(freshTemp, '');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldTemp, twoHoursAgo, twoHoursAgo);

    const result = spawnSync(hookPath, ['codex'], {
      input: JSON.stringify({ session_id: '019fd200-0000-7000-8000-000000000002', cwd: '/repo' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(stateDir, `${deadPid}.json`))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, '1.json'))).toBe(true);
    expect(fs.existsSync(oldTemp)).toBe(false);
    expect(fs.existsSync(freshTemp)).toBe(true);
    // The write this run performed is intact.
    expect(fs.existsSync(path.join(stateDir, `${process.pid}.json`))).toBe(true);
  });

  it('rejects a traversal session id before creating a temporary sidecar', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const history = path.join(root, 'history');
    fs.mkdirSync(home);

    const result = spawnSync(hookPath, ['codex'], {
      input: JSON.stringify({ session_id: '../escaped', cwd: '/repo' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENTS_HISTORY_DIR: history, AGENTS_RUN_MODE: 'edit' },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(history, 'escaped.json'))).toBe(false);
    expect(fs.existsSync(path.join(history, 'by-session'))).toBe(false);
  });
});
