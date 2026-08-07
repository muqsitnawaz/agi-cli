import { describe, it, expect } from 'vitest';

import {
  LABELABLE_AGENT_IDS,
  isLabelableAgent,
  stableAccountIdentity,
  accountFingerprint,
  canLabelIdentity,
} from './capability.js';
import {
  ACCOUNT_INSPECTION_AGENT_IDS,
  HARD_DEPRECATED_AGENT_IDS,
  type AccountInfo,
} from '../agents.js';

function info(partial: Partial<AccountInfo>): AccountInfo {
  return {
    accountKey: null,
    usageKey: null,
    accountId: null,
    organizationId: null,
    userId: null,
    email: null,
    plan: null,
    usageStatus: null,
    overageCredits: null,
    lastActive: null,
    signedIn: false,
    ...partial,
  };
}

describe('account label capability registry', () => {
  it('is exactly the account-inspectable set minus hard-deprecated harnesses', () => {
    const expected = ACCOUNT_INSPECTION_AGENT_IDS.filter((id) => !HARD_DEPRECATED_AGENT_IDS.includes(id));
    expect([...LABELABLE_AGENT_IDS].sort()).toEqual([...expected].sort());
    // gemini is hard-deprecated, so it must NOT be labelable even though it is inspectable.
    expect(isLabelableAgent('gemini')).toBe(false);
    expect(isLabelableAgent('claude')).toBe(true);
  });

  it('never lists a harness that lost account inspection', () => {
    for (const id of LABELABLE_AGENT_IDS) {
      expect(ACCOUNT_INSPECTION_AGENT_IDS).toContain(id);
    }
  });
});

describe('accountFingerprint', () => {
  it('is a deterministic, non-secret hash of the stable identity', () => {
    const a = info({ signedIn: true, accountKey: 'claude:account=uuid-1:org=uuid-2' });
    const fp1 = accountFingerprint('claude', a);
    const fp2 = accountFingerprint('claude', { ...a });
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{32}$/);
    // The raw account id must not appear in the fingerprint.
    expect(fp1).not.toContain('uuid-1');
  });

  it('prefers accountKey, then email, then accountId', () => {
    expect(stableAccountIdentity('codex', info({ signedIn: true, accountKey: 'k', email: 'a@b.co', accountId: 'x' }))).toBe('k');
    expect(stableAccountIdentity('codex', info({ signedIn: true, email: 'A@B.co', accountId: 'x' }))).toBe('codex:email=a@b.co');
    expect(stableAccountIdentity('codex', info({ signedIn: true, accountId: 'x' }))).toBe('codex:account=x');
  });

  it('returns null for a generic signed-in identity with no distinguishing key', () => {
    const generic = info({ signedIn: true });
    expect(accountFingerprint('opencode', generic)).toBeNull();
    expect(canLabelIdentity('opencode', generic)).toBe(false);
  });

  it('returns null when signed out even if an old key lingers', () => {
    expect(accountFingerprint('claude', info({ signedIn: false, accountKey: 'k' }))).toBeNull();
  });

  it('refuses to label an identity on a non-labelable harness', () => {
    expect(canLabelIdentity('openclaw', info({ signedIn: true, accountKey: 'k' }))).toBe(false);
  });
});
