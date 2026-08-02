import { describe, expect, test } from 'bun:test';
import { buildForkSessionRequest } from './forkSession';

describe('buildForkSessionRequest', () => {
  test('continues the source transcript with the same harness and local device', () => {
    expect(buildForkSessionRequest({ sessionId: 'session-123', agentKey: 'Codex' })).toEqual({
      ok: true,
      sessionId: 'session-123',
      agentKey: 'codex',
      host: undefined,
      prompt: '/continue session-123',
    });
  });

  test('preserves the source host for a remote session', () => {
    expect(buildForkSessionRequest({
      sessionId: 'session-remote',
      agentKey: 'claude',
      host: 'yosemite-s0',
    })).toMatchObject({ ok: true, agentKey: 'claude', host: 'yosemite-s0' });
  });

  test('rejects a terminal before its session id is available', () => {
    expect(buildForkSessionRequest({ agentKey: 'gemini' })).toEqual({
      ok: false,
      reason: 'no_session',
    });
  });

  test('rejects a terminal without a recognized agent harness', () => {
    expect(buildForkSessionRequest({ sessionId: 'session-123' })).toEqual({
      ok: false,
      reason: 'no_agent',
    });
  });
});
