import { describe, expect, it } from 'vitest';
import { parseBundleKey, planAccountSyncDestination } from './accounts.js';

describe('accounts credential import', () => {
  it('parses the bundle and key without tying the account to an agent version', () => {
    expect(parseBundleKey('openrouter.ai:OPENROUTER_API_KEY')).toEqual({
      bundle: 'openrouter.ai',
      key: 'OPENROUTER_API_KEY',
    });
  });

  it('rejects incomplete secret references', () => {
    expect(() => parseBundleKey('openrouter.ai')).toThrow('Expected bundle:key');
    expect(() => parseBundleKey(':KEY')).toThrow('Expected bundle:key');
  });
});

describe('account sync destination preflight', () => {
  const local = { id: 'account-1', name: 'work' };

  it('refuses to mutate an ordinary same-named secrets bundle', () => {
    expect(() => planAccountSyncDestination(local, [], [{ name: 'work' }])).toThrow(
      "secrets bundle 'work' is not this account",
    );
  });

  it('refuses to overwrite a different account with the same name', () => {
    expect(() => planAccountSyncDestination(local, [
      { kind: 'provider', id: 'account-2', name: 'work' },
    ], [{ name: 'work' }])).toThrow('different ACCOUNT_ID');
  });

  it('reconciles a remote rename by stable id', () => {
    expect(planAccountSyncDestination(local, [
      { kind: 'provider', id: 'account-1', name: 'old-work' },
    ], [{ name: 'old-work' }])).toEqual({ deleteRenamedBundle: 'old-work' });
  });

  it('fails loud when the remote already has duplicate stable ids', () => {
    expect(() => planAccountSyncDestination(local, [
      { kind: 'provider', id: 'account-1', name: 'old-work' },
      { kind: 'provider', id: 'account-1', name: 'work' },
    ], [{ name: 'old-work' }, { name: 'work' }])).toThrow('multiple account bundles');
  });
});
