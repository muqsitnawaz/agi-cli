/**
 * Read-side helpers that map a LIVE harness identity to its logical label — used
 * by `agents accounts list`, the device inventory (`devices accounts` /
 * `harnesses`), and `agents view` to annotate each signed-in install with the
 * label it belongs to (or flag drift when a bound version no longer matches).
 */
import type { AccountInfo } from '../agents.js';
import type { AgentId } from '../types.js';
import { accountFingerprint } from './capability.js';
import { labelForFingerprint, readAccountLabels, type AccountLabelsRegistry } from './registry.js';

/**
 * The logical label a live identity belongs to, or null. Pass a preloaded
 * registry to avoid re-reading the file per install on a hot inventory path.
 */
export function labelForIdentity(
  agent: AgentId,
  info: AccountInfo,
  registry?: AccountLabelsRegistry,
): string | null {
  const fingerprint = accountFingerprint(agent, info);
  if (!fingerprint) return null;
  return labelForFingerprint(registry ?? readAccountLabels(), agent, fingerprint);
}
