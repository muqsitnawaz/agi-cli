import { expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { SessionCliStream, type SessionCliEvent } from './sessionCliStream';

test('SessionCliStream forwards the canonical CLI envelope without renaming fields', async () => {
  const expected: SessionCliEvent = {
    version: 1,
    type: 'reset',
    streamId: 'stream-1',
    sequence: 1,
    capturedAt: 10,
    scope: 'zion',
    rows: [{ rowKey: 'row-1', sourceDevice: 'zion', sessionId: 'session-1' }],
  };
  const received = await new Promise<SessionCliEvent>((resolve, reject) => {
    const stream = new SessionCliStream({
      emit: (event) => { stream.stop(); resolve(event); },
      onError: reject,
      spawnWatch: () => spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify(expected)}\n`)})`]),
    });
    stream.start();
  });
  expect(received).toEqual(expected);
});
