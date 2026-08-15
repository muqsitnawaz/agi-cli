import { describe, it, expect } from 'vitest';
import { taskMatchesCaller, resolveCallerIdentity } from './caller-identity.js';

describe('taskMatchesCaller', () => {
  it('matches on sessionId', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { sessionId: 'sess-a' },
      ),
    ).toBe(true);
  });

  it('matches on launchId when session differs', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { launchId: 'launch-1' },
      ),
    ).toBe(true);
  });

  it('does not match when neither identity overlaps', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { sessionId: 'sess-b', launchId: 'launch-2' },
      ),
    ).toBe(false);
  });

  it('does not match an empty caller against a stamped task', () => {
    expect(
      taskMatchesCaller({ sessionId: 'sess-a' }, {}),
    ).toBe(false);
  });
});

describe('resolveCallerIdentity', () => {
  it('prefers explicit AGENT_SESSION_ID / AGENT_LAUNCH_ID from the env', () => {
    const id = resolveCallerIdentity({
      AGENT_SESSION_ID: 'env-session-1',
      AGENT_LAUNCH_ID: 'env-launch-1',
    } as NodeJS.ProcessEnv);
    expect(id.sessionId).toBe('env-session-1');
    expect(id.launchId).toBe('env-launch-1');
    expect(id.actor).toBeTruthy();
  });

  it('accepts AGENTS_SESSION_ID as the plural form', () => {
    const id = resolveCallerIdentity({
      AGENTS_SESSION_ID: 'plural-session',
      AGENT_LAUNCH_ID: 'launch-x',
    } as NodeJS.ProcessEnv);
    expect(id.sessionId).toBe('plural-session');
  });
});
