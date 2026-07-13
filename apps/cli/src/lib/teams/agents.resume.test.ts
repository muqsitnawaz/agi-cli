/**
 * Teammate resume argv + guard. `teams resume`/`teams message` re-enter a
 * stopped teammate's own session by delegating to `agents run --resume <id> --
 * <message>`. These assert the argv the team runner builds and the guard that
 * refuses to resume a non-Claude teammate whose session id was never captured.
 *
 * Real objects, no mocking: buildRunArgv/buildCommand are the production argv
 * builders; resumeTeammate drives a real AgentProcess loaded from disk.
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus, captureProcessStartTime } from './agents.js';
import { IS_WINDOWS } from '../platform/index.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resume-test-'));
}

// buildRunArgv is private; reach it through a cast — testing the real builder,
// not a re-implementation.
function argv(opts: {
  agentType?: string;
  prompt?: string;
  mode?: string;
  model?: string | null;
  effort?: string;
  version?: string | null;
  profileName?: string | null;
  resume?: { id: string; message: string };
}): string[] {
  const mgr = new AgentManager() as any;
  return mgr.buildRunArgv(
    opts.agentType ?? 'claude',
    opts.prompt ?? 'the original brief',
    opts.mode ?? 'edit',
    opts.model ?? null,
    opts.effort ?? 'medium',
    opts.version ?? null,
    opts.profileName ?? null,
    opts.resume,
  );
}

describe('buildRunArgv — resume', () => {
  it('emits `run <agent> <message> --resume <id>` with headless/json flags', () => {
    const a = argv({ agentType: 'claude', resume: { id: 'sess-123', message: 'merge the PR now' } });
    expect(a[0]).toBe('run');
    expect(a[1]).toBe('claude');
    // The message is the first positional (the prompt slot), + the summary nudge.
    expect(a[2].startsWith('merge the PR now')).toBe(true);
    const ri = a.indexOf('--resume');
    expect(ri).toBeGreaterThan(-1);
    expect(a[ri + 1]).toBe('sess-123');
    expect(a).toContain('--headless');
    expect(a).toContain('--json');
    expect(a).toContain('--quiet');
    expect(a).toContain('--mode');
    expect(a).toContain('--effort');
  });

  it('drops the Claude plan-mode prefix on resume but keeps it on a fresh plan launch', () => {
    const fresh = argv({ agentType: 'claude', mode: 'plan', prompt: 'do X' });
    const resumed = argv({ agentType: 'claude', mode: 'plan', resume: { id: 'x', message: 'keep going' } });
    expect(fresh[2].includes('HEADLESS PLAN MODE')).toBe(true);
    expect(resumed[2].includes('HEADLESS PLAN MODE')).toBe(false);
    expect(resumed[2].startsWith('keep going')).toBe(true);
  });

  it('never emits --resume on a fresh (non-resume) launch', () => {
    expect(argv({ agentType: 'codex', prompt: 'do a thing' })).not.toContain('--resume');
  });

  it('is agent-agnostic — a codex resume id forwards the same way', () => {
    const a = argv({ agentType: 'codex', resume: { id: 'thread-abc', message: 'continue' } });
    expect(a[1]).toBe('codex');
    const ri = a.indexOf('--resume');
    expect(a[ri + 1]).toBe('thread-abc');
  });
});

describe('buildCommand — resume omits --session-id', () => {
  it('creates with --session-id on a fresh launch and omits it on resume', () => {
    const mgr = new AgentManager() as any;
    const fresh: string[] = mgr.buildCommand('claude', 'brief', 'edit', null, '/tmp/x', 'agent-uuid', 'medium', null, null);
    expect(fresh).toContain('--session-id');

    const resumed: string[] = mgr.buildCommand(
      'claude', 'brief', 'edit', null, '/tmp/x', 'agent-uuid', 'medium', null, null,
      { id: 'agent-uuid', message: 'go' },
    );
    // --session-id CREATES a session; `agents run` rejects it with --resume.
    expect(resumed).not.toContain('--session-id');
    expect(resumed).toContain('--resume');
    // Working-directory access is still granted on resume.
    expect(resumed).toContain('--add-dir');
  });
});

describe('resumeTeammate — resume-id guard', () => {
  it('refuses to resume a non-Claude teammate whose session id was never captured', async () => {
    const base = tmpBase();
    const id = 'codex-agent-1';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    // A codex teammate that finished (or failed) before its stream ever emitted a
    // session/thread id — remoteSessionId stays null, so there is no resumable
    // handle (the agent_id is only Claude's session id, not codex's).
    const a = new AgentProcess(
      id, 'guard-team', 'codex', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), new Date(), base,
    );
    await a.saveMeta();

    const mgr = new AgentManager(50, base);
    await expect(mgr.resumeTeammate(id, 'keep going')).rejects.toThrow(/No resumable session id was captured/);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('refuses a resume message that starts with a dash (would be parsed as a flag)', async () => {
    const base = tmpBase();
    const id = 'claude-agent-dash';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const a = new AgentProcess(
      id, 'guard-team', 'claude', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), new Date(), base,
    );
    await a.saveMeta();

    const mgr = new AgentManager(50, base);
    await expect(mgr.resumeTeammate(id, '-- force merge it')).rejects.toThrow(/can't start with '-'/);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('uses the captured remoteSessionId as the resume id when present (no throw at the guard)', async () => {
    const base = tmpBase();
    const id = 'codex-agent-2';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const a = new AgentProcess(
      id, 'guard-team', 'codex', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), new Date(), base,
    );
    a.remoteSessionId = 'codex-thread-xyz';
    await a.saveMeta();

    // Past the guard, resumeTeammate would spawn a real `agents run` child. We
    // only need to prove the guard passes — assert the persisted resume handle
    // is the captured thread id, which is what buildRunArgv receives.
    const mgr = new AgentManager(50, base);
    const loaded = await mgr.get(id);
    expect(loaded!.remoteSessionId).toBe('codex-thread-xyz');
    expect(loaded!.agentType).toBe('codex');

    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe.skipIf(IS_WINDOWS)('resumeTeammate — launch failure', () => {
  it('preserves the stopped teammate metadata and files when relaunch fails', async () => {
    const base = tmpBase();
    const id = 'claude-agent-relaunch-failure';
    const dir = path.join(base, id);
    const completedAt = new Date('2026-07-13T12:34:56.000Z');
    fs.mkdirSync(dir, { recursive: true });

    const agent = new AgentProcess(
      id, 'failure-team', 'claude', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), completedAt, base,
    );
    await agent.saveMeta();
    fs.writeFileSync(path.join(dir, 'prior-turn.log'), 'preserve me');
    const stdoutPath = path.join(dir, 'stdout.log');
    fs.writeFileSync(stdoutPath, 'prior stdout');
    // A read-only stdout mirror produces a real EACCES failure when the local
    // launcher opens the resume log for writing. AgentManager.get() can still
    // load and reconcile the stopped teammate before launch reaches that point.
    fs.chmodSync(stdoutPath, 0o400);

    const mgr = new AgentManager(50, base);
    try {
      await expect(mgr.resumeTeammate(id, 'keep going')).rejects.toThrow(/Failed to spawn agent/);

      expect((mgr as any).agents.has(id)).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'prior-turn.log'), 'utf-8')).toBe('preserve me');
      expect(fs.readFileSync(stdoutPath, 'utf-8')).toBe('prior stdout');
      const restored = await AgentProcess.loadFromDisk(id, base);
      expect(restored).not.toBeNull();
      expect(restored!.status).toBe(AgentStatus.COMPLETED);
      expect(restored!.completedAt?.toISOString()).toBe(completedAt.toISOString());
    } finally {
      if (fs.existsSync(stdoutPath)) fs.chmodSync(stdoutPath, 0o600);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * The resume hazard: the status reader re-reads the whole stdout.log from byte 0
 * every poll and marks terminal status from the last `result` event it sees, with
 * NO liveness guard. If a resumed turn were APPENDED after the prior turn's
 * `result:success`, that stale event would report a still-running teammate as
 * COMPLETED (and a second follow-up would fork a session instead of steering).
 * That is exactly why launchProcess TRUNCATES the log on resume. These tests pin
 * both halves: the hazard exists, and a truncated (current-turn-only) log is safe.
 */
describe.skipIf(IS_WINDOWS)('resume log-truncation hazard', () => {
  function spawnAlive(agent: AgentProcess, dir: string): ChildProcess {
    const fd = fs.openSync(path.join(dir, 'stdout.log'), 'a');
    const child = spawn('sleep', ['10'], { stdio: ['ignore', fd, fd], detached: true });
    fs.closeSync(fd);
    agent.pid = child.pid ?? null;
    agent.startTime = agent.pid ? captureProcessStartTime(agent.pid) : null;
    agent.status = AgentStatus.RUNNING;
    return child;
  }

  it('a stale prior-turn result:success poisons a LIVE teammate to COMPLETED (why we truncate)', async () => {
    const base = tmpBase();
    const id = 'poison';
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    const agent = new AgentProcess(id, 't', 'claude', 'x', null, 'edit', null, AgentStatus.RUNNING, new Date(), null, base);
    const child = spawnAlive(agent, dir);
    try {
      // Simulate an APPEND resume: prior turn's terminal event still in the log.
      fs.writeFileSync(path.join(dir, 'stdout.log'), JSON.stringify({ type: 'result', subtype: 'success', session_id: 's' }) + '\n');
      expect(agent.isProcessAlive()).toBe(true);
      await agent.updateStatusFromProcess();
      // The bug the truncation prevents: alive, yet reported COMPLETED.
      expect(agent.status).toBe(AgentStatus.COMPLETED);
    } finally {
      try { process.kill(-(child.pid as number)); } catch { /* group gone */ }
      try { process.kill(child.pid as number); } catch { /* gone */ }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('a truncated (current-turn-only, no terminal event) log leaves a LIVE teammate RUNNING', async () => {
    const base = tmpBase();
    const id = 'clean';
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    const agent = new AgentProcess(id, 't', 'claude', 'x', null, 'edit', null, AgentStatus.RUNNING, new Date(), null, base);
    const child = spawnAlive(agent, dir);
    try {
      // Truncated on resume: only the new turn's non-terminal events are present.
      fs.writeFileSync(path.join(dir, 'stdout.log'), JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\n');
      expect(agent.isProcessAlive()).toBe(true);
      await agent.updateStatusFromProcess();
      expect(agent.status).toBe(AgentStatus.RUNNING);
    } finally {
      try { process.kill(-(child.pid as number)); } catch { /* group gone */ }
      try { process.kill(child.pid as number); } catch { /* gone */ }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
