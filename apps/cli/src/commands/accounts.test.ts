import { describe, expect, it } from 'vitest';
import { assertAgentTarget, parseAgentSource, parseBundleKey } from './accounts.js';

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

describe('accounts native-source grammar', () => {
  it('parses a bare harness and a versioned source', () => {
    expect(parseAgentSource('claude')).toEqual({ agent: 'claude', version: undefined });
    expect(parseAgentSource('claude@2.1.220')).toEqual({ agent: 'claude', version: '2.1.220' });
  });

  it('rejects an unknown harness as a source', () => {
    expect(() => parseAgentSource('nope@1')).toThrow("Unknown harness 'nope'");
  });
});

describe('accounts attach target', () => {
  it('accepts a bare harness id', () => {
    expect(assertAgentTarget('claude')).toBe('claude');
  });

  it('refuses a versioned target — a default account spans every version', () => {
    expect(() => assertAgentTarget('claude@2.1.220')).toThrow('not a version');
  });

  it('refuses an unknown harness', () => {
    expect(() => assertAgentTarget('nope')).toThrow("Unknown harness 'nope'");
  });
});
