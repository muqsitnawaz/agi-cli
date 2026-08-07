/**
 * Canonical account-capability metadata for logical account labels.
 *
 * A logical account **label** (e.g. `work`, `personal`) is a fleet-synced name
 * for one signed-in identity, spanning several harnesses. This module owns the
 * two questions every label surface asks:
 *
 *   1. Which harnesses can be labeled at all? — {@link LABELABLE_AGENT_IDS}.
 *   2. What is the stable, non-secret fingerprint of a given identity? —
 *      {@link accountFingerprint}.
 *
 * Both answers are **registry-driven**, not a pile of per-agent branches. The
 * labelable set is derived from the existing account-inspection registry
 * (`ACCOUNT_INSPECTION_AGENT_IDS`) minus hard-deprecated harnesses, and the
 * fingerprint is a single priority chain over the already-normalized
 * {@link AccountInfo} that `getAccountInfo` returns for every harness — so a new
 * harness that gains account inspection becomes labelable with no code here, and
 * the completeness test (`capability.test.ts`) pins the two lists together.
 */
import * as crypto from 'crypto';

import {
  ACCOUNT_INSPECTION_AGENT_IDS,
  HARD_DEPRECATED_AGENT_IDS,
  type AccountInfo,
} from '../agents.js';
import type { AgentId } from '../types.js';

/**
 * Harnesses whose local credentials expose enough state to attach a logical
 * label. This is the account-inspection registry minus the hard-deprecated
 * harnesses (a label can't be attached to a harness we no longer install into,
 * e.g. gemini). Deriving it — rather than hand-listing — keeps it honest as
 * harnesses move between the inspection and deprecation sets.
 */
export const LABELABLE_AGENT_IDS: readonly AgentId[] = ACCOUNT_INSPECTION_AGENT_IDS.filter(
  (id) => !HARD_DEPRECATED_AGENT_IDS.includes(id),
);

const LABELABLE_AGENTS = new Set<AgentId>(LABELABLE_AGENT_IDS);

/** Whether a logical account label may be attached to this harness. */
export function isLabelableAgent(agentId: AgentId): boolean {
  return LABELABLE_AGENTS.has(agentId);
}

/**
 * The stable identity string for an account, or `null` when the credential is a
 * generic "signed in" with no distinguishing key — which must NOT be labeled,
 * because two such installs are indistinguishable and a label on one would
 * silently claim the other.
 *
 * Priority, most-stable first: the composite `accountKey` (org/account-scoped,
 * cross-device stable for uuid-based harnesses); then a normalized `email`; then
 * a bare `accountId`. The result is hashed by {@link accountFingerprint}, never
 * stored raw, so no email or account id lands in the fleet-synced registry.
 */
export function stableAccountIdentity(agentId: AgentId, info: AccountInfo): string | null {
  if (!info.signedIn) return null;
  if (info.accountKey) return info.accountKey;
  if (info.email) return `${agentId}:email=${info.email.trim().toLowerCase()}`;
  if (info.accountId) return `${agentId}:account=${info.accountId.trim()}`;
  return null;
}

/**
 * A non-secret, stable fingerprint of an account's identity, or `null` when the
 * identity is too generic to label. The central labels registry stores ONLY this
 * — a SHA-256 of the {@link stableAccountIdentity} string, truncated to 32 hex
 * chars — so the fleet-synced file never carries a raw email or account id.
 *
 * The same identity produces the same fingerprint on every machine that reads it
 * the same way (uuid/email-keyed harnesses are cross-device stable; a harness
 * whose key is a per-device token hash is stable per device — see the caveat in
 * docs/06-observability.md).
 */
export function accountFingerprint(agentId: AgentId, info: AccountInfo): string | null {
  const identity = stableAccountIdentity(agentId, info);
  if (!identity) return null;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

/** Whether this specific signed-in identity has a stable fingerprint to label. */
export function canLabelIdentity(agentId: AgentId, info: AccountInfo): boolean {
  return isLabelableAgent(agentId) && accountFingerprint(agentId, info) !== null;
}
