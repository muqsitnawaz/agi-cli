import { describe, it, expect } from 'vitest';
import { getProviderAdapter, listApiKeyProviders } from './account-provider-registry.js';

describe('account provider registry', () => {
  it('returns the cursor adapter', () => {
    const adapter = getProviderAdapter('cursor');
    expect(adapter.agent).toBe('cursor');
    expect(adapter.keyEnvVar).toBe('CURSOR_API_KEY');
  });

  it('cursor adapter rejects an empty key', () => {
    const adapter = getProviderAdapter('cursor');
    expect(() => adapter.validateKey('')).toThrow('cannot be empty');
    expect(() => adapter.validateKey('   ')).toThrow('cannot be empty');
  });

  it('cursor adapter accepts a non-empty key', () => {
    const adapter = getProviderAdapter('cursor');
    expect(() => adapter.validateKey('sk-abc123')).not.toThrow();
  });

  it('throws for an unsupported agent', () => {
    expect(() => getProviderAdapter('claude' as 'cursor')).toThrow("No API-key provider adapter");
  });

  it('lists cursor in api-key providers', () => {
    expect(listApiKeyProviders()).toContain('cursor');
  });
});
