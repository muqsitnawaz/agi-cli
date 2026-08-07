---
kind: plan
title: Logical account labels across devices and harness versions
summary: >
  Name a signed-in identity once, bind it to installed versions per device, and
  route runs and routines to it by name — without ever copying a credential. The
  fleet-synced registry stores only hashed fingerprints; explicit account routing
  fails loud instead of falling back to another identity.
status: implementing
tracking: "#2300"
facts:
  - Central ~/.agents/accounts.yaml stores one SHA-256 fingerprint per (label, harness)
  - Per-device ~/.agents/devices/<host>/accounts.yaml maps a label to versions or '*'
  - attach verifies the version's live identity before writing; run --account never falls back
  - Labelable harnesses are derived from ACCOUNT_INSPECTION_AGENT_IDS, pinned by a completeness test
---

# Logical account labels across devices and harness versions

## Purpose

Every installed harness version keeps its own credential, so one Claude or Codex
version can be signed into different identities on different machines, and one
identity can back several versions. `agents devices accounts` / `harnesses`
expose raw identities but cannot give them a durable name or record an intended
version assignment. Operators want to name an identity once, say which installed
versions on which device run under it, and select it for a run or routine — with
no credential ever leaving the version home.

<div class="artifact-callout">A label names an identity; a device binding names where that identity is installed. Only a non-secret fingerprint crosses the device boundary, and a binding is written only after the live identity matches.</div>

## Proposed Changes

Two synced files, both separate from `agents.yaml` (an older CLI rewrites
`agents.yaml` but never these, so it cannot erase them), plus a verified,
fail-loud resolver shared by `run` and routines.

<svg viewBox="0 0 920 300" role="img" aria-label="Account label data flow" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#8b949e"/></marker></defs>
  <rect x="24" y="96" width="210" height="108" rx="14" fill="#161b22" stroke="#a3e635" stroke-width="3"/>
  <text x="129" y="134" fill="#a3e635" text-anchor="middle" font-size="19">Version home</text>
  <text x="129" y="164" fill="#ffffff" text-anchor="middle" font-size="15">local credential</text>
  <text x="129" y="186" fill="#8b949e" text-anchor="middle" font-size="13">never copied</text>
  <rect x="332" y="34" width="256" height="96" rx="14" fill="#161b22" stroke="#58a6ff" stroke-width="3"/>
  <text x="460" y="72" fill="#58a6ff" text-anchor="middle" font-size="18">accounts.yaml (synced)</text>
  <text x="460" y="100" fill="#ffffff" text-anchor="middle" font-size="14">label -> fingerprint</text>
  <rect x="332" y="172" width="256" height="96" rx="14" fill="#161b22" stroke="#d2a8ff" stroke-width="3"/>
  <text x="460" y="210" fill="#d2a8ff" text-anchor="middle" font-size="18">devices/&lt;host&gt;/accounts.yaml</text>
  <text x="460" y="238" fill="#ffffff" text-anchor="middle" font-size="14">label -> versions | '*'</text>
  <rect x="686" y="96" width="210" height="108" rx="14" fill="#161b22" stroke="#a3e635" stroke-width="3"/>
  <text x="791" y="134" fill="#a3e635" text-anchor="middle" font-size="19">run --account</text>
  <text x="791" y="164" fill="#ffffff" text-anchor="middle" font-size="15">verified pick</text>
  <text x="791" y="186" fill="#f0883e" text-anchor="middle" font-size="13">fail loud, no fallback</text>
  <path d="M234 128 L332 90" stroke="#8b949e" stroke-width="3" marker-end="url(#arrow)"/>
  <text x="270" y="96" fill="#8b949e" font-size="12">fingerprint</text>
  <path d="M234 172 L332 216" stroke="#8b949e" stroke-width="3" marker-end="url(#arrow)"/>
  <text x="270" y="212" fill="#8b949e" font-size="12">bind version</text>
  <path d="M588 82 L686 122" stroke="#8b949e" stroke-width="3" marker-end="url(#arrow)"/>
  <path d="M588 220 L686 178" stroke="#8b949e" stroke-width="3" marker-end="url(#arrow)"/>
</svg>

| File | Role |
| --- | --- |
| `src/lib/accounts/capability.ts` | `LABELABLE_AGENT_IDS` (derived, pinned by a completeness test) + `accountFingerprint` (accountKey -> email -> accountId, hashed) |
| `src/lib/accounts/registry.ts` | Central `~/.agents/accounts.yaml`: one fingerprint per (label, harness); one-identity-per-label enforced |
| `src/lib/accounts/bindings.ts` | Per-device `~/.agents/devices/<host>/accounts.yaml`: version lists, `'*'` = version-global |
| `src/lib/accounts/resolve.ts` | `resolveAccountLabel` — verifies live identity per candidate, fails loud, never falls back |
| `src/lib/accounts/status.ts` | `labelForIdentity` — annotates inventory / `view` rows |
| `src/commands/accounts.ts` | `list / label / attach / detach / rename / remove` |
| `src/commands/exec.ts` | `agents run --account <label>` (reject cloud/lease) |
| `src/lib/runner.ts` | routine `account:` accepts a label (fail loud) |
| `src/lib/devices/harness-inventory.ts` | additive `label` on `HarnessRow` / `AccountGroup` |

## Public Interface

```bash
agents accounts label work claude@2.1.220         # name the live identity; bind that version
agents accounts attach work codex@0.146.0         # add a second harness to the same label
agents accounts attach work codex@*               # version-global: every installed codex here
agents accounts list --json                       # labels, identities, bindings, drift
agents accounts detach work claude@2.1.219        # drop one device binding
agents run claude --account work                  # run only a verified 'work' version
```

Routines pin a label the same way: `account: work` in the routine YAML.

## Validation

| Check | How |
| --- | --- |
| Fingerprints only, no secrets synced | `registry.test.ts` asserts the file carries no `@`/email |
| One identity cannot be two labels | `registry.test.ts` expects a throw on the second label |
| `'*'` expands to all installed; list intersects installs | `bindings.test.ts` |
| Verified match resolves; drifted identity fails loud | `resolve.test.ts` (real claude install fixture) |
| Device default is normalized `machineId()` | `accounts.test.ts` asserts binding under `devices/testbox/` |
| Labelable set == inspectable − hard-deprecated | `capability.test.ts` completeness test |

```bash
bun run build && npx vitest run src/lib/accounts src/commands/accounts.test.ts
```

## Risks

| Risk | Control |
| --- | --- |
| A bound version drifts to another identity | `run --account` / `list` re-verify the live fingerprint; a mismatch is skipped / flagged |
| Rotation silently picks another account | `--account` bypasses the strategy path and fails loud |
| Synced config leaks identity | The central registry holds only truncated SHA-256 fingerprints |
| A per-device token-hash identity differs across boxes | Documented; attach re-verifies on each device that binds it |

## Tracking

- [GitHub issue #2300](https://github.com/phnx-labs/agents-cli/issues/2300)
- Delivered in this PR: library, command, `run`/routine wiring, inventory labels, tests, docs, CHANGELOG.
