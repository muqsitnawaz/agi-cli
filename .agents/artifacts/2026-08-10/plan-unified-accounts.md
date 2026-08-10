---
kind: plan
title: Unify native logins and provider accounts (account core)
surface: cli
status: shipped
date: 2026-08-10
project: agents-cli
repository: phnx-labs/agents-cli
ticket: RUSH-2527
---

# Unify native logins and provider accounts — account core

## Focus for review

- **One account namespace, two kinds.** A provider credential account
  (`accounts add`, a policy-`never` secrets bundle) and a native account record
  (`accounts name`, metadata only in `meta.accounts.native`) share one name
  namespace, one lookup (`findUnifiedAccount`), and one renderer.
- **Native records copy no OAuth.** A native account stores a stable id + identity
  key + label + scope — never the harness's credential. A native lookup reads only
  `meta`, never the provider bundle store or the keychain.
- **Attachment scope is harness-derived.** `account-capabilities.ts` decides
  version-scoped (attach to `agent@version`) vs device-scoped (attach to the bare
  `agent`). `attach` validates the live identity before binding and injects nothing.
- **Resolution order.** `resolveAccountSelection`: explicit → exact-target binding
  → device-scoped binding → per-harness default.
- **Seam.** This track is the account model + command surface + the resolution
  contract. Runtime injection (validate live fingerprint / inject provider env),
  profile/routine consumption, and fleet/harness inventory labels are wired by the
  runtime/fleet-auth track; fleet credential transport is owned by the
  credential-transport track — this PR does not duplicate them.

## What the user experiences

- **Before.** A native login had no durable name; the account surface only held
  provider keys, and there was no way to bind a specific identity to a specific
  installation.
- **After.**
  - `agents accounts name claude@2.1.220 work` names the signed-in Claude login;
    the record is metadata only.
  - `agents accounts attach work claude@2.1.225` binds it to another installation
    once that install is signed in to the same identity; for a device-scoped
    harness, `agents accounts attach cursor-work cursor`.
  - `agents accounts` lists provider bundles and named native logins together;
    `agents accounts view work` shows kind, custody, and attachments (text/JSON).
  - `agents accounts remove <name>` refuses while a binding, default, or harness
    profile still references it.

## Current architecture

| Concern | File |
|---|---|
| Provider credential accounts (bundles) + native records + bindings + unified resolution | `src/lib/account-registry.ts` |
| Per-harness native capability (inspection / scope / status) | `src/lib/account-capabilities.ts` (new) |
| Native-login discovery | `src/lib/account-catalog.ts` |
| Provider injection adapters | `src/lib/account-provider-registry.ts` |
| Command surface (positional grammar, unified renderer) | `src/commands/accounts.ts` |
| `meta.accounts.native` / `bindings` shape | `src/lib/types.ts` |

## Implementation (what changed)

- `account-registry.ts`: `NativeAccount` / `UnifiedAccount`, `listNativeAccounts`,
  `findUnifiedAccount`, `addNativeAccount`, `bindAccount` / `unbindAccount` /
  `accountBindings`, and `resolveAccountSelection` extended to consult bindings.
  `add` / `rename` / `remove` enforce the unified namespace and reference-safety.
- `account-capabilities.ts`: `NATIVE_ACCOUNT_CAPABILITIES` — every harness
  classified exactly once; a `supported` harness must have inspectable identity.
- `accounts.ts`: positional `name` / `attach` / `detach`, unified `view` (alias
  `inspect`), positional `sync <account> <device>`, and a merged native+provider
  list renderer.
- `types.ts`: `meta.accounts.native` (records) + `meta.accounts.bindings`
  (target → account id).

```bash
agents accounts name claude@2.1.220 work
agents accounts attach work claude@2.1.225
agents accounts view work --json
agents accounts sync openrouter-work yosemite-s0
```

## Validation

- Real-path unit tests: registry binding resolution + reference-safe remove
  (`account-registry.test.ts`), capability completeness
  (`account-capabilities.test.ts`), discovery grouping (`account-catalog.test.ts`).
  `./scripts/build.sh --skip-tests` green; account + adjacent (harness/profiles)
  suites green.
- Built-binary evidence: `agents accounts --help` renders the positional grammar
  and workflow-first examples.

## Tracking

- RUSH-2527 — Unify native and provider accounts across installations, profiles,
  and fleet auth. This PR: account core (model + command + resolution contract).
  Runtime/fleet-auth wiring and credential transport are sibling tracks.
