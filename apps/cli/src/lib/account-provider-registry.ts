import type { AgentId } from './types.js';

export interface AccountProviderAdapter {
  agent: AgentId;
  /** The env var name to inject at spawn time. */
  keyEnvVar: string;
  /** Validate a raw API key before it is persisted. */
  validateKey(key: string): void;
}

const CURSOR_ADAPTER: AccountProviderAdapter = {
  agent: 'cursor',
  keyEnvVar: 'CURSOR_API_KEY',
  validateKey(key: string): void {
    if (!key || !key.trim()) throw new Error('Cursor API key cannot be empty.');
  },
};

const ADAPTERS = new Map<AgentId, AccountProviderAdapter>([
  ['cursor', CURSOR_ADAPTER],
]);

/** Return the adapter for an agent that supports api-key auth. Throws for unsupported agents. */
export function getProviderAdapter(agent: AgentId): AccountProviderAdapter {
  const adapter = ADAPTERS.get(agent);
  if (!adapter) {
    throw new Error(
      `No API-key provider adapter for agent '${agent}'. Supported: ${[...ADAPTERS.keys()].join(', ')}.`,
    );
  }
  return adapter;
}

/** Agents that support api-key account creation. */
export function listApiKeyProviders(): AgentId[] {
  return [...ADAPTERS.keys()];
}
