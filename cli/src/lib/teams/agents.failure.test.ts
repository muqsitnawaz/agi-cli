import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

const roots: string[] = [];
const tmpBase = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-team-failure-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function persist(
  base: string,
  id: string,
  name: string,
  status: AgentStatus,
  after: string[] = [],
): Promise<AgentProcess> {
  const agent = new AgentProcess(
    id, 'failure-team', 'claude', 'test task', null, 'plan', null, status,
    new Date(), status === AgentStatus.COMPLETED ? new Date() : null,
    base, null, null, null, null, null, null, null, name, after,
  );
  await agent.saveMeta();
  return agent;
}

describe('durable teammate failure evidence', () => {
  it('survives a fresh manager/status invocation and redacts home paths', async () => {
    const base = tmpBase();
    const failed = await persist(base, 'failed-root', 'bad-root', AgentStatus.FAILED);
    failed.failure = {
      stage: 'spawn', code: 'local-spawn-failed',
      message: 'spawn denied in /Users/alice/private', exit_code: null,
      retryable: true, observed_at: '2026-08-25T21:00:00.000Z',
    };
    await failed.saveMeta();

    const fresh = new AgentManager(50, base);
    const [loaded] = await fresh.listByTask('failure-team');
    expect(loaded.failure).toEqual({
      stage: 'spawn', code: 'local-spawn-failed',
      message: 'spawn denied in [HOME]/private', exit_code: null,
      retryable: true, observed_at: '2026-08-25T21:00:00.000Z',
    });
  });

  it('terminalizes a failed dependency explicitly while an independent branch remains complete', async () => {
    const base = tmpBase();
    const failed = await persist(base, 'failed-root', 'bad-root', AgentStatus.FAILED);
    failed.failure = {
      stage: 'placement', code: 'no-viable-device', message: 'No viable device.',
      exit_code: null, retryable: false, observed_at: new Date().toISOString(),
    };
    await failed.saveMeta();
    await persist(base, 'good-root', 'good-root', AgentStatus.COMPLETED);
    await persist(base, 'blocked-child', 'blocked-child', AgentStatus.PENDING, ['bad-root']);

    const manager = new AgentManager(50, base);
    expect(await manager.startReady('failure-team')).toEqual([]);
    const byName = new Map((await manager.listByTask('failure-team')).map((a) => [a.name, a]));
    expect(byName.get('good-root')?.status).toBe(AgentStatus.COMPLETED);
    expect(byName.get('blocked-child')?.status).toBe(AgentStatus.FAILED);
    expect(byName.get('blocked-child')?.failure).toMatchObject({
      stage: 'dependency', code: 'dependency-failed', retryable: false,
      message: 'Blocked by dependency: bad-root (failed).',
    });
  });
});
