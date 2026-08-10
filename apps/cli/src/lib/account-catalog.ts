/**
 * Unified account discovery (RUSH-2470).
 *
 * Two kinds of account can authenticate a harness, and this module lists them
 * as one set:
 *
 *   - `bundle`      a canonical credential account (an `agents secrets` bundle;
 *                   see [[account-registry]] / [[account-schema]]).
 *   - `oauth-native` a harness's own OAuth login (Claude's native sign-in, …).
 *
 * Native OAuth stays native: it is surfaced here for selection but is never
 * copied into or rewritten as a bundle — the harness continues to own it. The
 * native source is injected (an array or a lazy supplier) rather than probed
 * here, so this module stays pure over its inputs and the harness-login
 * inspection lives with the harness code that owns it.
 */
import type { AgentId } from './types.js';
import { getUserAgentsDir } from './state.js';
import { hasKeychainToken } from './secrets/index.js';
import { readAccountRegistry, type CredentialAccount } from './account-registry.js';
import type { AccountAuthKind } from './account-provider-registry.js';

export type AccountSource = 'bundle' | 'oauth-native';

/** A harness-owned native OAuth login, surfaced but not converted. */
export interface NativeOAuthAccount {
  agent: AgentId;
  provider: string;
  display: string;
  fingerprint?: string;
}

/** One row of unified account discovery. */
export interface CatalogAccount {
  source: AccountSource;
  name: string;
  provider: string;
  /** Auth kind — set for bundle accounts only. */
  auth?: AccountAuthKind;
  /** Stable id (ACCOUNT_ID) — set for bundle accounts only. */
  id?: string;
  /** Owning harness — set for native OAuth accounts only. */
  agent?: AgentId;
  /** Whether the credential is present on this device. */
  secretPresent: boolean;
}

export interface AccountCatalogOptions {
  base?: string;
  /** Native OAuth logins to fold into discovery (default: none). */
  nativeAccounts?: NativeOAuthAccount[] | (() => NativeOAuthAccount[]);
}

export function catalogFromCredential(account: CredentialAccount): CatalogAccount {
  return {
    source: 'bundle',
    name: account.name,
    provider: account.provider,
    auth: account.auth,
    id: account.id,
    secretPresent: hasKeychainToken(account.secretRef),
  };
}

export function catalogFromNative(account: NativeOAuthAccount): CatalogAccount {
  return {
    source: 'oauth-native',
    name: account.display,
    provider: account.provider,
    agent: account.agent,
    // A native login's credential lives inside the harness; its presence is
    // the harness's business, so discovery reports it as available.
    secretPresent: true,
  };
}

/**
 * List every account across both sources, sorted by name (then source), with
 * bundle-backed credential accounts and native OAuth logins side by side.
 */
export function listAccountCatalog(opts: AccountCatalogOptions = {}): CatalogAccount[] {
  const base = opts.base ?? getUserAgentsDir();
  const bundle = Object.values(readAccountRegistry(base).accounts).map(catalogFromCredential);
  const nativeSource = opts.nativeAccounts;
  const native = (typeof nativeSource === 'function' ? nativeSource() : nativeSource ?? []).map(catalogFromNative);
  return [...bundle, ...native].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}
