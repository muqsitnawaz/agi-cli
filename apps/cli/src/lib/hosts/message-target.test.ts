/**
 * `agents message` reaching a detached `--device --no-follow` dispatch
 * (RUSH-2366, third defect). The pure delivery decision is unit-tested here; a
 * real-file test proves the same host records `agents hosts ps` reads are what
 * resolve a message target by name / session id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decideHostDispatchDelivery } from './message-target.js';
import type { HostTask } from './tasks.js';

function task(overrides: Partial<HostTask>): HostTask {
  return {
    id: 'abcd1234',
    host: 'yosemite-s0',
    target: 'yosemite-s0.tail.ts.net',
    agent: 'claude',
    prompt: 'do a thing',
    remoteLog: '$HOME/.agents/.cache/hosts/abcd1234.log',
    remoteExit: '$HOME/.agents/.cache/hosts/abcd1234.exit',
    status: 'running',
    createdAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('decideHostDispatchDelivery', () => {
  it('forwards a running dispatch that has a session id', () => {
    const d = decideHostDispatchDelivery(task({ name: 'lifecycle', sessionId: 'sess-1', identityFile: '/k' }));
    expect(d).toEqual({
      kind: 'forward',
      host: 'yosemite-s0',
      target: 'yosemite-s0.tail.ts.net',
      sessionId: 'sess-1',
      identityFile: '/k',
      label: 'lifecycle',
    });
  });

  it('is unreachable (with a recovery hint) when running but no session id captured yet', () => {
    const d = decideHostDispatchDelivery(task({ name: 'lifecycle', sessionId: undefined }));
    expect(d.kind).toBe('unreachable');
    if (d.kind === 'unreachable') {
      expect(d.reason).toMatch(/has not registered a resumable session id/);
      expect(d.reason).toMatch(/agents hosts logs lifecycle/);
      expect(d.reason).toMatch(/agents hosts stop lifecycle/);
    }
  });

  it('is unreachable (points at logs) once the dispatch has finished', () => {
    const d = decideHostDispatchDelivery(task({ name: 'lifecycle', status: 'completed', exitCode: 0, sessionId: 'sess-1' }));
    expect(d.kind).toBe('unreachable');
    if (d.kind === 'unreachable') {
      expect(d.reason).toMatch(/has already finished/);
      expect(d.reason).toMatch(/agents hosts logs lifecycle/);
    }
  });

  it('labels by id when the dispatch was launched without --name', () => {
    const d = decideHostDispatchDelivery(task({ sessionId: 'sess-1' }));
    if (d.kind === 'forward') expect(d.label).toBe('abcd1234');
  });
});

describe('host dispatch records resolve a message target by name / session id', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-msg-hosts-'));
    vi.resetModules();
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    vi.doUnmock('../state.js');
    vi.resetModules();
  });

  it('findTaskByName / findTaskBySessionId read the same <id>.json records', async () => {
    vi.doMock('../state.js', async () => {
      const actual = await vi.importActual<typeof import('../state.js')>('../state.js');
      return { ...actual, getCacheDir: () => cacheDir };
    });
    const { saveTask, findTaskByName, findTaskBySessionId } = await import('./tasks.js');

    saveTask(task({ id: 'ffff0000', name: 'lifecycle-recovery', sessionId: 'sess-xyz' }));

    expect(findTaskByName('lifecycle-recovery')?.id).toBe('ffff0000');
    expect(findTaskBySessionId('sess-xyz')?.id).toBe('ffff0000');
    expect(findTaskByName('nope')).toBeNull();
  });
});
