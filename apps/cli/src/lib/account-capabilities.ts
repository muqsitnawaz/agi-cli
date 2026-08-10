import type { AgentId } from './types.js';

export interface NativeAccountCapability {
  inspection: 'strong' | 'opaque' | 'none';
  scope: 'version' | 'device' | 'unsupported';
  status: 'supported' | 'discovery-only' | 'unsupported';
}

/** Canonical truth for native-account naming and attachment semantics. */
export const NATIVE_ACCOUNT_CAPABILITIES: Record<AgentId, NativeAccountCapability> = {
  claude: { inspection: 'strong', scope: 'version', status: 'supported' },
  codex: { inspection: 'strong', scope: 'version', status: 'supported' },
  grok: { inspection: 'strong', scope: 'version', status: 'supported' },
  muse: { inspection: 'strong', scope: 'version', status: 'supported' },
  cursor: { inspection: 'strong', scope: 'device', status: 'supported' },
  opencode: { inspection: 'strong', scope: 'device', status: 'supported' },
  antigravity: { inspection: 'strong', scope: 'device', status: 'supported' },
  kimi: { inspection: 'strong', scope: 'device', status: 'supported' },
  droid: { inspection: 'strong', scope: 'device', status: 'supported' },
  gemini: { inspection: 'strong', scope: 'unsupported', status: 'discovery-only' },
  copilot: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  openclaw: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  amp: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  kiro: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  goose: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  hermes: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  pi: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
  warp: { inspection: 'none', scope: 'unsupported', status: 'unsupported' },
};

export function nativeAccountCapability(agent: AgentId): NativeAccountCapability {
  return NATIVE_ACCOUNT_CAPABILITIES[agent];
}
