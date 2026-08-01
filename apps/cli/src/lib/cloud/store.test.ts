import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate BOTH stores under a temp HOME before any import touches them: the cloud
// tasks.db and the sessions index db read their base dir lazily at first use.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-cloudstore-'));
process.env.HOME = TEST_HOME;

import { insertTask, updateTaskStatus, getTaskById } from './store.js';
import { registerCloudSession } from './session-index.js';
import { findSessionsById, closeDB } from '../session/db.js';
import type { CloudTask } from './types.js';

function cloudTask(overrides: Partial<CloudTask> = {}): CloudTask {
  return {
    id: '019fb-exec-codex-1',
    provider: 'codex',
    status: 'queued',
    agent: 'codex',
    prompt: 'refactor the parser\nsecond line',
    repo: 'phnx-labs/agents-cli',
    branch: 'feat/x',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('insertTask reconciles the cloud store into the session index', () => {
  it('registers a session row keyed by the real execution id at dispatch', () => {
    insertTask(cloudTask());

    const byId = findSessionsById('019fb-exec-codex-1');
    expect(byId).toHaveLength(1);
    expect(byId[0].agent).toBe('codex');
    expect(byId[0].label).toBe('[cloud/queued] feat/x');
    expect(byId[0].filePath).toBe(''); // remote transcript sentinel
    expect(byId[0].topic).toBe('refactor the parser');
  });

  it('refreshes the [cloud/<status>] label on a status poll', () => {
    insertTask(cloudTask({ id: '019fb-exec-codex-2', status: 'queued' }));
    updateTaskStatus('019fb-exec-codex-2', 'running');
    expect(findSessionsById('019fb-exec-codex-2')[0].label).toBe('[cloud/running] feat/x');

    updateTaskStatus('019fb-exec-codex-2', 'completed', { prUrl: 'https://github.com/o/r/pull/9' });
    const done = findSessionsById('019fb-exec-codex-2')[0];
    expect(done.label).toBe('[cloud/completed] feat/x');
    expect(done.prUrl).toBe('https://github.com/o/r/pull/9');
    // The store row itself carries the PR url the poll wrote.
    expect(getTaskById('019fb-exec-codex-2')!.prUrl).toBe('https://github.com/o/r/pull/9');
  });
});

describe('registerCloudSession guards', () => {
  it('skips a provider whose agent is not session-tracked (nothing to resolve by id)', () => {
    registerCloudSession({ ...cloudTask({ id: 'factory-run-1' }), provider: 'factory', agent: 'factory' });
    expect(findSessionsById('factory-run-1')).toHaveLength(0);
  });

  it('never seeds a row for a fabricated codex-<ts> id', () => {
    // Belt-and-suspenders: codex.ts fails loud instead of minting one, but the
    // charset guard here also rejects an id that isn't a usable execution id.
    registerCloudSession(cloudTask({ id: 'codex-1720000000000 not valid' }));
    expect(findSessionsById('codex-1720000000000 not valid')).toHaveLength(0);

    closeDB();
  });
});
