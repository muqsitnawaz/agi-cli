/**
 * The single source of truth for how each harness authenticates for a HEADLESS /
 * fleet-managed run — replacing the scattered, disagreeing per-agent credential
 * tables (`getAccountInfo`'s `switch`, `FLEET_AUTH_FILES`, `KEYCHAIN_BOUND_ON_MAC`,
 * `LEASE_RUNTIMES`, `PROFILE_AUTH_ENV_KEYS_BY_RUNTIME`) with one registry keyed off
 * the agent id — the pattern the repo's own review rules require (no `if (agent ===
 * '…')` arms).
 *
 * The invariant it encodes (Muqsit's requirement, non-negotiable): agents-cli
 * NEVER reads, holds, syncs, or copies a harness's INTERACTIVE / rotating login
 * credential. The only credential it manages is a long-lived, non-rotating
 * setup-token / API key — safe to hold file-based and fleet-sync. Reading the
 * actual Claude setup-token is `account-token.ts`'s job (per-account, file-backed);
 * this module only declares, per harness, WHICH model applies so callers
 * (`buildExecEnv` injection, `auth-sync` copy decisions) branch off the registry
 * instead of hardcoding agent names.
 */

import type { AgentId } from './types.js';

/**
 * How a harness is authenticated for a headless / fleet-managed run — the only
 * credential class agents-cli is allowed to hold and move.
 *
 *  - `setup-token` — a long-lived, non-rotating OAuth token from an explicit setup
 *    step (`claude setup-token`). Consumed via {@link CredentialModel.envVar};
 *    resolved per-account by `account-token.ts`. Safe to hold file-based + sync.
 *  - `api-key` — a long-lived provider API key / bearer consumed via an env var.
 *    Same safety profile: non-rotating, file-holdable, fleet-syncable.
 *  - `login-only` — the harness has ONLY an interactive/rotating login we must never
 *    hold or copy. Headless use needs a per-machine login (the device-code flow in
 *    remote-login.ts), NEVER a credential copy.
 */
export type CredentialKind = 'setup-token' | 'api-key' | 'login-only';

export interface CredentialModel {
  kind: CredentialKind;
  /**
   * The env var the harness reads its managed credential from. Present iff `kind`
   * is `setup-token` or `api-key`; absent for `login-only`.
   */
  envVar?: string;
}

/**
 * The credential model for every harness. `login-only` is the honest default for a
 * harness with no stable, holdable credential path we manage — it means
 * "per-machine login, never a copy", not "unsupported".
 *
 * Antigravity declares `ANTIGRAVITY_API_KEY` in the profile presets, but its login
 * is keychain-bound loopback OAuth and no managed-key run is verified end-to-end,
 * so it stays `login-only` until confirmed against `agy`. Droid (keyfile) and Kimi
 * (OAuth-only) have no API-key path — `login-only`.
 */
export const CREDENTIAL_MODEL: Record<AgentId, CredentialModel> = {
  claude: { kind: 'setup-token', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' },
  codex: { kind: 'api-key', envVar: 'OPENAI_API_KEY' },
  grok: { kind: 'api-key', envVar: 'XAI_API_KEY' },
  gemini: { kind: 'login-only' },
  antigravity: { kind: 'login-only' },
  kimi: { kind: 'login-only' },
  droid: { kind: 'login-only' },
  cursor: { kind: 'login-only' },
  opencode: { kind: 'login-only' },
  openclaw: { kind: 'login-only' },
  copilot: { kind: 'login-only' },
  amp: { kind: 'login-only' },
  kiro: { kind: 'login-only' },
  goose: { kind: 'login-only' },
  hermes: { kind: 'login-only' },
  forge: { kind: 'login-only' },
};

/** The env var a harness reads its managed credential from, or null when login-only. */
export function credentialEnvVar(agent: AgentId): string | null {
  return CREDENTIAL_MODEL[agent]?.envVar ?? null;
}

/**
 * Whether a harness's auth is a long-lived, non-rotating SETUP-TOKEN that agents-cli
 * manages in the file-based auth bundle (currently: claude). For these, the
 * interactive/rotating login is NEVER read or copied host-to-host — copying it
 * rotates→revokes the token and logs the fleet out. `apply` skips them; their auth
 * travels as the synced auth bundle, seeded via `/fleet:mint-auth`.
 *
 * Scoped to `setup-token` (not `api-key`) on purpose: api-key harnesses (codex,
 * grok) still propagate their existing login file until their key path is wired +
 * verified — a separate change, so this one introduces no untested regression.
 */
export function isSetupTokenAgent(agent: AgentId): boolean {
  return CREDENTIAL_MODEL[agent]?.kind === 'setup-token';
}
