import { describe, it, expect } from 'vitest';

import { AGENTS } from './agents.js';
import type { AgentId } from './types.js';
import {
  CREDENTIAL_MODEL,
  credentialEnvVar,
  isSetupTokenAgent,
} from './credentials.js';

describe('CREDENTIAL_MODEL registry', () => {
  it('covers every AgentId in the registry (harness parity — no agent left undeclared)', () => {
    for (const id of Object.keys(AGENTS) as AgentId[]) {
      expect(CREDENTIAL_MODEL[id], `missing credential model for '${id}'`).toBeDefined();
    }
  });

  it('declares an envVar iff the harness is not login-only', () => {
    for (const [id, model] of Object.entries(CREDENTIAL_MODEL)) {
      if (model.kind === 'login-only') {
        expect(model.envVar, `login-only '${id}' must not declare an envVar`).toBeUndefined();
      } else {
        expect(model.envVar, `${model.kind} '${id}' must declare an envVar`).toBeTruthy();
      }
    }
  });

  it('models claude as a setup-token agent reading CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(CREDENTIAL_MODEL.claude).toEqual({ kind: 'setup-token', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' });
    expect(credentialEnvVar('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('isSetupTokenAgent', () => {
  it('is true ONLY for setup-token harnesses (claude), gating the never-copy-login rule', () => {
    // This is the switch that stops `apply` copying claude's rotating login (the
    // daily-logout fix). It must be true for claude and false for everything else —
    // including api-key harnesses, whose existing login-file copy is unchanged here.
    expect(isSetupTokenAgent('claude')).toBe(true);
    expect(isSetupTokenAgent('codex')).toBe(false); // api-key, not setup-token
    expect(isSetupTokenAgent('grok')).toBe(false); // api-key
    expect(isSetupTokenAgent('gemini')).toBe(false);
    expect(isSetupTokenAgent('antigravity')).toBe(false); // login-only (keychain-bound)
    expect(isSetupTokenAgent('kimi')).toBe(false);
    expect(isSetupTokenAgent('droid')).toBe(false);
  });
});
