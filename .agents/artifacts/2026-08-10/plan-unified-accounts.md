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
  (`accounts add`) and a named native login (`accounts name`) now share one name
  namespace, one lookup, and one renderer. Is the boundary between "credential we
  store" and "native login we only name" clear at every command?
- **Native aliases are metadata only.** An alias stores a stable id + the identity
  fingerprint `sha256(agent\0identity)` — never a token, OAuth payload, or raw
  email. Confirm no native auth bytes are ever copied or synced.
- **Positional grammar.** `name <source> <name>`, `view <account>`,
  `attach/detach <account> <harness>`, `sync <account> <device>`; `set-default` /
  `clear-default` retained as aliases. Reads object-first — right shape?
- **Migration.** Retired version-bound labels are recovered into aliases by their
  preserved fingerprint, once, then archived `.migrated`.
- **Runtime seam is untouched.** This track is the account *model + command*
  surface. Runtime/profile/fleet-auth wiring is a separate track; `attach` writes
  only the existing `meta.accounts.defaults` (provider accounts), so no run path
  changes here.

## What the user experiences

- **Before.** A signed-in native login had no durable name — `agents view claude`
  showed a bare email, and the retired `labels:` design was never launched.
  Provider keys existed (`accounts add`), but the two lived in separate mental
  models with `--from`/`--to`-shaped flags.
- **After.**
  - `agents accounts name claude@2.1.220 work` → the `claude` login is named
    `work`; the name follows the identity fingerprint, so it survives version
    changes and shows in `agents accounts`.
  - `agents accounts` lists provider account bundles **and** named native logins
    in one view (text and `--json` share one renderer).
  - `agents accounts view work` shows either kind; `agents accounts attach
    openrouter-work deepseek` binds a credential account as a harness default;
    `agents accounts sync openrouter-work yosemite-s0` copies a bundle (a native
    alias reports it has nothing to copy — native logins are per-device).
  - `agents accounts remove <name>` refuses while a harness profile or a default
    binding still references the account.

## Current architecture (before)

- `account-registry.ts` — provider credential accounts as `agents secrets`
  bundles (RUSH-2470); CRUD + resolution + legacy `accounts.yaml` migration.
- `account-catalog.ts` — live discovery of native logins (`discoverNativeAccounts`).
- `account-provider-registry.ts` — per-provider injection adapters.
- `commands/accounts.ts` — `add / set-key / inspect / rename / remove /
  set-default / clear-default / sync`. Native logins had **no durable name**, and
  the label archive was discarded, not recovered.

## Implementation (what changed)

| Change | File |
|---|---|
| Native-login alias store (fingerprint-keyed, metadata only) + legacy-label recovery | `src/lib/account-aliases.ts` (new) + `account-aliases.test.ts` |
| Shared name validator for the one namespace | `src/lib/account-schema.ts` (`ACCOUNT_NAME_RE`, `assertAccountName`) |
| Discovery stitches aliases onto live logins (`applyNativeAliases`) | `src/lib/account-catalog.ts` |
| Legacy `labels:` fold into aliases, archive `.migrated` | `src/lib/account-registry.ts` |
| Positional grammar, shared renderer, unified `view`, safe remove/reference checks, `attach`/`detach`, positional `sync` | `src/commands/accounts.ts` + `accounts.test.ts` |

```bash
agents accounts name claude@2.1.220 work
agents accounts view work
agents accounts attach openrouter-work deepseek
agents accounts sync openrouter-work yosemite-s0
```

## Validation

- Real-path unit tests against temp homes: alias CRUD + fingerprint match + legacy
  recovery (`account-aliases.test.ts`), discovery merge (`account-catalog.test.ts`),
  registry label-fold (`account-registry.test.ts`), positional-grammar parsing
  (`accounts.test.ts`). `./scripts/build.sh --skip-tests` passes; account +
  adjacent (harness/profiles/byok) suites green.
- Built-binary evidence: `agents accounts --help` renders the workflow-first
  examples and full positional command tree.

## Tracking

- RUSH-2527 — Unify native and provider accounts across installations, profiles,
  and fleet auth (this track: account core).
