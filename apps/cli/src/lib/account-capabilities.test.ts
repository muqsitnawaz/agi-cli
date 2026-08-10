import { describe, expect, it } from 'vitest';
import { ALL_AGENT_IDS } from './agents.js';
import { NATIVE_ACCOUNT_CAPABILITIES } from './account-capabilities.js';

describe('native account capability registry', () => {
  it('classifies every harness exactly once', () => {
    expect(Object.keys(NATIVE_ACCOUNT_CAPABILITIES).sort()).toEqual([...ALL_AGENT_IDS].sort());
  });

  it('does not claim attachment support without inspectable identity state', () => {
    for (const capability of Object.values(NATIVE_ACCOUNT_CAPABILITIES)) {
      if (capability.status === 'supported') expect(capability.inspection).not.toBe('none');
    }
  });
});
