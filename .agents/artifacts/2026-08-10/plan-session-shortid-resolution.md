---
kind: plan
surface: internal
title: Fix the design error in session short-ID resolution
summary: >
  agents sessions preview <shortId> refuses to render when an unrelated
  registered device is offline, because short-ID resolution is modeled as
  fleet-wide uniqueness consensus instead of a session-ownership lookup. Key
  strictness on owner reachability; READ paths render the unique reachable match
  with an unconfirmed-peers note; ACT paths stay fail-closed against the
  prefix-collision hole.
status: awaiting-go
tracking: "RUSH-2479 (dependency: PR #2485)"
facts:
  - "Root cause: metadataResolveOutcome returns partial on any dark peer before the uniqueness gate (sessions.ts:5269)."
  - "Owner field already exists: session.machine -> sessionOwnerDevice (resume-owner.ts:64); resume uses it, preview does not."
  - "READ lenient / ACT fail-closed is a safety line: a dark peer can hide a same-prefix session."
  - "Hard dependency on PR #2485 (RUSH-2479) making machine attribution correct for offloaded runs."
---

## Focus for review

- **The reframe:** resolution strictness keys on **owner-device reachability**, not "did every registered device answer." An unrelated offline peer must never block a short ID a reachable box uniquely owns.
- **READ lenient, ACT fail-closed — by safety.** Preview / `--resolve` render the unique reachable match; resume / attach / focus / exec keep fail-closing on an unconfirmed short prefix, because a dark peer can hide a *different* session sharing the 8-hex prefix and resuming the wrong conversation is unrecoverable.
- **New outcome kind `resolved-unconfirmed`** (not a field) so all six consumers are forced to handle it; `assertNever` on the ACT paths.
- **Spec:** SES-9a is the clause encoding the error and gets rewritten.
- **Ordering:** lands after PR #2485 so `session.machine` reflects the executor for offloaded runs.

## Intent

Your words: *"we should not have to use `--local`, it should properly identify if the device is local or not"* and *"this is not a bug, it is a design error."* Right on both. The design models a short-ID lookup as fleet-wide consensus; it should be an ownership lookup. After this, `--local` is an optimization you never *need* to peek at a session a reachable box owns.

## Purpose

`agents sessions preview 019fe983` refused to render because an unrelated offline device (`mac-mini`) could not be consulted, even though this machine's index already held the unique match. The resolver treats a short-ID lookup as a fleet-wide uniqueness consensus and fails closed on any dark peer, when it should be a session-ownership lookup keyed on `session.machine`. This plan fixes that so an unrelated offline box never blocks resolving a session a reachable device owns.

## Current architecture

`agents sessions preview <shortId>` resolves through the fleet fan-out, and `metadataResolveOutcome` fails closed the moment any registered device is dark — discarding a unique reachable match. The ownership signal it should use (`session.machine`) is already there and already used by resume.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 900 340" role="img" aria-label="Resolution decision: today fails closed on any dark peer; proposed keys on owner reachability">
    <text x="20" y="24" fill="#8aa0b4" font-family="JetBrains Mono, monospace" font-size="12">short id -&gt; fan out to fleet -&gt; metadataResolveOutcome</text>

    <rect x="20" y="44" width="190" height="46" rx="8" fill="#11161c" stroke="#2b3440" stroke-width="1.5"/>
    <text x="34" y="72" fill="#c9d4e0" font-family="JetBrains Mono, monospace" font-size="13">any peer dark?</text>

    <rect x="20" y="150" width="360" height="72" rx="8" fill="#3a1720" stroke="#7f1d1d" stroke-width="1.5"/>
    <text x="34" y="178" fill="#eaf2fb" font-family="JetBrains Mono, monospace" font-size="13" font-weight="600">TODAY: return partial</text>
    <text x="34" y="201" fill="#c9d4e0" font-family="JetBrains Mono, monospace" font-size="13">unique reachable match discarded</text>
    <line x1="110" y1="90" x2="110" y2="150" stroke="#7f1d1d" stroke-width="1.5"/>
    <text x="122" y="128" fill="#8aa0b4" font-family="JetBrains Mono, monospace" font-size="12">yes -&gt; fail closed</text>

    <rect x="470" y="118" width="410" height="62" rx="8" fill="#12241a" stroke="#1f6f43" stroke-width="1.5"/>
    <text x="484" y="144" fill="#eaf2fb" font-family="JetBrains Mono, monospace" font-size="13" font-weight="600">PROPOSED: unique among reachable?</text>
    <text x="484" y="166" fill="#c9d4e0" font-family="JetBrains Mono, monospace" font-size="12">yes -&gt; resolved (+unconfirmedPeers if a peer was dark)</text>
    <line x1="210" y1="67" x2="470" y2="140" stroke="#1f6f43" stroke-width="1.5" stroke-dasharray="3 3"/>
    <text x="250" y="104" fill="#8aa0b4" font-family="JetBrains Mono, monospace" font-size="12">key on OWNER, not "every device"</text>

    <rect x="470" y="210" width="410" height="52" rx="8" fill="#2a2410" stroke="#7a5c12" stroke-width="1.5"/>
    <text x="484" y="240" fill="#c9d4e0" font-family="JetBrains Mono, monospace" font-size="12">no reachable match + dark peer -&gt; partial (honest)</text>
    <line x1="675" y1="180" x2="675" y2="210" stroke="#7a5c12" stroke-width="1.5"/>

    <rect x="470" y="280" width="410" height="46" rx="8" fill="#12241a" stroke="#1f6f43" stroke-width="1.5"/>
    <text x="484" y="308" fill="#c9d4e0" font-family="JetBrains Mono, monospace" font-size="12">READ renders + notes; ACT fails closed on unconfirmed prefix</text>
    <line x1="675" y1="262" x2="675" y2="280" stroke="#1f6f43" stroke-width="1.5"/>
  </svg>
  <figcaption><b>Figure.</b> Resolution today (left, red) fails closed on any dark peer. Proposed (right) keys on owner reachability; <code>partial</code> is reserved for the one undecidable case.</figcaption>
</figure>

The data path and the exact fail-closed ordering:

```ts
// sessions.ts:5249  metadataResolveOutcome (origin/main)
if (FULL_SESSION_ID_RE.test(selector) && candidates.length === 1 && exact) return resolved; // UUID exempt
if (remote.unreachable.length > 0) return { kind: 'partial', failedPeers };  // <- discards a unique reachable match
if (candidates.length === 0) return not-found;
if (candidates.length > 1)  return ambiguous;
return resolved;
```

The ownership signal, already present and unused by preview:

```ts
// resume-owner.ts:64 — returns the owning peer, or undefined when this box is the owner
export function sessionOwnerDevice(session: Pick<SessionMeta, 'machine'>): string | undefined {
  const owner = session.machine?.trim();
  return owner && !isSelfHost(owner) ? owner : undefined;
}
```

## Behavior: current vs proposed

**Today — an unrelated peer offline blocks the peek:**

```console
$ agents sessions preview 019fe983
  mac-mini: unreachable or no agents CLI — skipped
Partial session resolution: mac-mini did not answer.
No preview was rendered because the short ID may be ambiguous on an unreachable peer.
$ echo $?
2
# workaround the user should not need:
$ agents sessions preview 019fe983 --local   # renders
```

**Proposed — renders the unique match, notes the dark peer:**

```console
$ agents sessions preview 019fe983
codex · RUSH-2459 · yosemite-s0
  cwd     ~/src/github.com/muqsitnawaz/agents-cli
  last    "trace the offload attribution seam ..."
  files   3 changed · 0 errors · tests 12/12
note: mac-mini offline — showing the unique match from the reachable fleet;
      couldn't confirm no same-prefix session lives there.
$ echo $?
0
# resume stays safe on an unconfirmed prefix:
$ agents resume 019fe983            # still fails closed (collision risk)
$ agents resume 019fe983-b3e9-...   # full UUID: resolves + hops
```

## Proposed changes

**1. New outcome kind (`sessions.ts:5131`)** — a distinct kind, not a field, so every `if`-chain consumer is forced to handle it:

```diff
 export type MetadataResolveOutcome =
   | { kind: 'resolved'; session: SessionMeta }
+  | { kind: 'resolved-unconfirmed'; session: SessionMeta; unconfirmedPeers: string[] }
   | { kind: 'not-found' }
   | { kind: 'ambiguous'; candidates: FleetSessionCandidate[] }
   | { kind: 'partial'; failedPeers: string[] };
```

**2. Reorder `metadataResolveOutcome` (`sessions.ts:5249`)** — uniqueness among reachable devices before the dark-peer check; `partial` only when nothing reachable holds it:

```diff
-  if (remote.unreachable.length > 0) return { kind: 'partial', failedPeers: remote.unreachable };
-  if (candidates.length === 0) return { kind: 'not-found' };
-  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
-  return { kind: 'resolved', session: candidates[0].hits[0].session };
+  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
+  if (candidates.length === 1 && looksLikeSessionId(selector)) {
+    const session = candidates[0].hits[0].session;
+    return remote.unreachable.length > 0
+      ? { kind: 'resolved-unconfirmed', session, unconfirmedPeers: remote.unreachable }
+      : { kind: 'resolved', session };
+  }
+  if (remote.unreachable.length > 0) return { kind: 'partial', failedPeers: remote.unreachable }; // labels + no-match
+  if (candidates.length === 0) return { kind: 'not-found' };
+  return { kind: 'resolved', session: candidates[0].hits[0].session };
```

**3. Consumers.** READ renders `resolved-unconfirmed` with an owner-aware note; ACT fails closed on it for a non-UUID selector and asserts exhaustiveness:

```diff
 // resume / attach / focus / exec
 if (outcome.kind === 'resolved') { /* hop to sessionOwnerDevice, as today */ }
+else if (outcome.kind === 'resolved-unconfirmed') { failClosed(outcome.unconfirmedPeers); } // never silently hop
 else if (outcome.kind === 'partial') { failClosed(outcome.failedPeers); }
 else if (outcome.kind === 'ambiguous') { /* list + narrow */ }
 else if (outcome.kind === 'not-found') { /* not found */ }
+else { assertNever(outcome); }
```

## Public interface

No new flags. `--local` remains, but demotes from **required workaround** to **optional optimization**.

| Command | Selector | Unrelated peer offline | After |
| --- | --- | --- | --- |
| `sessions preview` / `--resolve` | short id | renders + note | was: refused |
| `resume` / `attach` / `focus` | short id | fail closed (+ optional `[y/N]` on interactive resume) | clearer message |
| `resume` / `preview` | full UUID | resolves | unchanged |
| any | label | `partial` | unchanged |

<aside class="artifact-callout"><strong>Load-bearing safety rule:</strong> <code>fleetCandidatesByQuery</code> groups by full session id (<code>sessions.ts:5182</code>), so a dark peer holding a <em>different</em> session with the same 8-hex prefix is structurally invisible. A READ may render the unique reachable match with a note; an ACT path must not silently resume it. That is why leniency is READ-only.</aside>

## Files

| File | Change |
| --- | --- |
| `apps/cli/src/commands/sessions.ts` | new kind; reorder `metadataResolveOutcome`; owner-aware note in `renderSessionPreview`; `--resolve` |
| `apps/cli/src/commands/{resume,attach,focus,exec}.ts` | fail-closed on unconfirmed prefix; `assertNever` tail |
| `apps/cli/docs/specifications.md` | rewrite SES-9a + scenario |
| `apps/cli/src/commands/sessions.test.ts` | rewrite `:1276`; keep `:2467`; add collision / no-reachable / trust-rows / offload / full-fleet-throw cases |
| `apps/cli/CHANGELOG` + `docs/05-sessions.md` | user-visible behavior change |

## Validation

```bash
# reproduce (a registered device offline), then confirm the fix
agents sessions preview <local-shortId>          # was: partial/no preview -> after: card + note
agents sessions preview <local-shortId> --local  # still works; no longer required
agents resume <shortId>                          # unrelated peer dark -> still fails closed
agents resume <full-uuid>                        # resolves + hops
bun test sessions.test.ts                         # rewritten :1276 + new cases; assertNever compiles the guard
```

## Risks

| Risk | Mitigation |
| --- | --- |
| Short-prefix collision hidden on a dark peer | READ renders + notes (recoverable); ACT fails closed on unconfirmed prefix (unrecoverable action stays safe) |
| Adding a field silently leaves consumers treating it as "go" | Distinct kind + `assertNever` on ACT paths turns an unhandled case into a compile error |
| Owner mis-attributed for offloaded runs -> hop to wrong box | Land after PR #2485 (`foldExecutionMachine`); test asserts hop targets the executor |
| Preview shows a session resume then refuses | Owner-aware note states the owner is offline (readable mirror, not resumable), not an unrelated peer |

## Tracking

- Surfaced from `agents sessions preview 019fe983` (session `019fe983`, codex, RUSH-2459).
- Depends on / coordinates with **PR #2485** (RUSH-2479, `foldExecutionMachine`).
- Adversarial design review: **GO-WITH-CHANGES**, corrections folded in.
- Open a Linear ticket at build time and back-reference it here.
