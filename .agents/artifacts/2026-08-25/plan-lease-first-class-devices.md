---
kind: plan
template: plan.v1
title: Leased boxes as first-class execution devices
summary: Make `agents run --lease` work end-to-end (deterministic bootstrap, correct account classification), then make a leased box discoverable in `devices list --all` and reusable via `--device <slug>` on the tailnet — no new flags.
project: AGI
repository: agents-cli
branch: lease-first-class-devices
status: awaiting-review
date: '2026-08-25'
links:
  - "https://tailscale.com/kb/1085/auth-keys"
---

## Purpose

`agents run --lease` provisions a cloud box for burst compute, sets up agents-cli, syncs the repo, loads the runtime account, runs the agent, and shreds credentials. In a live test it **failed every time**: the box provisions and bills, then the agent never starts, ending only with a misleading `agents-cli is not set up`. Two root causes:

1. **The bootstrap swallows the real failure.** `apps/cli/src/lib/crabbox/lease.ts:190` runs `agents setup >/dev/null 2>&1 || true`, discarding both the output and the exit code, then marches on into a guaranteed agent failure.
2. **A portable account is misclassified as native OAuth.** Passing a portable `claude-*` setup-token account still trips the native-OAuth transfer refusal, so the exact requested flow — "lease capacity and immediately run with my account" — is blocked before provisioning.

Separately, the box is a second-class citizen: `devices list --all` mentions leases only as text, `--all --json` omits them entirely, and `agents run … --device <slug>` cannot resolve a lease slug — so the natural "lease it, then reuse it" loop doesn't exist. This plan fixes the two bugs first (PR1), then makes a leased box a real, addressable, tailnet-joined device (PR2).

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> one swallowed line (<code>lease.ts:190</code>) is why every lease dies after it's billed. PR1 makes <code>--lease</code> work; PR2 makes the box a reusable <code>--device</code> on your mesh — with no new flag.</aside>

## Proposed Changes

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="mockup">
    <strong>Today</strong>
    <pre>$ agents run deepseek "…" --lease
✓ box ready
… (agent never starts)
agents-cli is not set up. Run: agents setup

$ agents devices list --all --json
{ "devices": [ … ] }   # leases OMITTED

$ agents run deepseek "…" --device swift-krill
error: unknown device "swift-krill"</pre>
    Box is billed, setup fails silently, and the lease is invisible to JSON and to <code>--device</code>. A portable setup-token account is wrongly refused as native OAuth.
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>After</strong>
    <pre>$ agents run deepseek "…" --lease
Leasing a Hetzner box on your tailnet…
✓ swift-krill ready
✓ agents-cli installed and set up
✓ DeepSeek account loaded for this run
&lt;agent output&gt;
Box swift-krill kept warm on your tailnet.
Reuse: agents run deepseek "…" --device swift-krill

$ agents devices list --all
Leased devices
  swift-krill  linux  ready  tailnet  ephemeral  expires 29m

$ agents run deepseek "…" --device swift-krill
Reusing leased device swift-krill…   # same box</pre>
    Account resolves before billing; bootstrap fails loud and is verified; the box shows up in <code>--all</code> (text + JSON) and is reusable via <code>--device</code> on your tailnet.
  </div>
</div>

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 900 300" role="img" aria-label="Before and after lease architecture">
    <text x="20" y="26" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="14">Before</text>
    <rect x="20" y="40" width="150" height="56" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="95" y="64" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui" font-size="12">run --lease</text>
    <text x="95" y="82" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">box billed</text>
    <rect x="210" y="40" width="200" height="56" rx="8" fill="#2a1414" stroke="#b91c1c" stroke-width="1.5"/>
    <text x="310" y="62" text-anchor="middle" fill="#fca5a5" font-family="JetBrains Mono, monospace" font-size="11">setup &gt;/dev/null || true</text>
    <text x="310" y="82" text-anchor="middle" fill="#fca5a5" font-family="Inter, system-ui" font-size="11">failure swallowed</text>
    <rect x="450" y="40" width="150" height="56" rx="8" fill="#2a1414" stroke="#b91c1c" stroke-width="1.5"/>
    <text x="525" y="70" text-anchor="middle" fill="#fca5a5" font-family="Inter, system-ui" font-size="12">agent never starts</text>
    <line x1="170" y1="68" x2="210" y2="68" stroke="#64748b" stroke-width="1.5"/>
    <line x1="410" y1="68" x2="450" y2="68" stroke="#64748b" stroke-width="1.5"/>
    <rect x="640" y="40" width="230" height="56" rx="8" fill="#2a1414" stroke="#b91c1c" stroke-width="1.5"/>
    <text x="755" y="62" text-anchor="middle" fill="#fca5a5" font-family="JetBrains Mono, monospace" font-size="11">--all --json → omitted</text>
    <text x="755" y="82" text-anchor="middle" fill="#fca5a5" font-family="JetBrains Mono, monospace" font-size="11">--device slug → unresolved</text>
    <text x="20" y="150" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="14">After</text>
    <rect x="20" y="166" width="150" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="95" y="190" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui" font-size="12">resolve account</text>
    <text x="95" y="210" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">before billing</text>
    <rect x="210" y="166" width="200" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="310" y="190" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui" font-size="12">bootstrap fail-loud</text>
    <text x="310" y="210" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">verify .system/.git</text>
    <rect x="450" y="166" width="200" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="550" y="190" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui" font-size="12">ExecutionDevice</text>
    <text x="550" y="210" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">registered ∪ leases</text>
    <rect x="690" y="166" width="180" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="780" y="190" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui" font-size="12">list --all / ssh</text>
    <text x="780" y="210" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">--device → reuse</text>
    <line x1="170" y1="196" x2="210" y2="196" stroke="#64748b" stroke-width="1.5"/>
    <line x1="410" y1="196" x2="450" y2="196" stroke="#64748b" stroke-width="1.5"/>
    <line x1="650" y1="196" x2="690" y2="196" stroke="#64748b" stroke-width="1.5"/>
  </svg>
  <figcaption><b>Figure.</b> PR1 resolves the account before the box is billed and makes bootstrap fail loud (verified by a git postcondition). PR2 adds one read-time <code>ExecutionDevice</code> projection (registered ∪ live leases) feeding <code>list --all</code>, <code>ssh</code>, and <code>--device</code>. Leases stay provider-owned ephemeral resources, never persistent registry entries.</figcaption>
</figure>

### PR1 · area 1 — Deterministic lease bootstrap

```diff title=apps/cli/src/lib/crabbox/lease.ts
@@ ENSURE_AGENTS_CLI @@
-'if [ ! -d "$HOME/.agents/.system" ]; then agents setup >/dev/null 2>&1 || true; fi',
+'if [ ! -d "$HOME/.agents/.system" ]; then',
+'  if ! agents setup 2>&1; then',
+'    echo "lease bootstrap: agents setup failed" >&2; exit 97;',
+'  fi',
+'fi',
+'if [ ! -d "$HOME/.agents/.system/.git" ]; then',
+'  echo "lease bootstrap: setup did not initialize ~/.agents/.system" >&2; exit 97;',
+'fi',
```

- `agents setup` is already non-interactive with no TTY — run it visibly, no `--yes` needed.
- Assert `~/.agents/.system/.git` exists before installing runtimes or launching the agent.
- On a `97` failure the command layer stops a **newly created** box (never an explicitly reused one) so it doesn't idle-bill, and surfaces the captured cause.

### PR1 · area 2 — Resolve + classify the account before leasing

- Move `resolveSpawnAccount` ahead of paid provisioning so `--account`, profile bindings, and defaults behave identically locally and on a lease — a bad account fails *before* a box exists.
- Recognize `CLAUDE_CODE_OAUTH_TOKEN` / `sk-ant-oat01-` setup-tokens as **portable** (the false-refusal fix); keep rejecting true native Claude/Codex OAuth session files.
- Shred temporary profile/account files after every run, including on kept boxes.

### PR2 · area 3 — Project leases into the device surface (read-time union)

```ts
type ExecutionDevice =
  | { kind: 'registered'; profile: DeviceProfile }
  | { kind: 'lease'; name: string; provider: 'crabbox'; ephemeral: true;
      lifecycle: 'starting'|'ready'|'unreachable'|'expired'|'stopped';
      network: 'tailscale'|'public'; address?: string; leaseId: string;
      expiresAt: number | null };
```

- One projection feeds `devices list --all` (text **and** `--json`, even with no registered devices), `agents ssh <slug>`, and `run … --device <slug>`.
- `--all` does live lease discovery; a provider/auth error is visible and non-zero, never a silent omission.
- Leases stay **out of `--device auto`** — automatic placement keeps using registered fleet workers only.
- Registered device + lease sharing a name → fail as ambiguous; `--box <slug>` stays the explicit disambiguator.

### PR2 · area 4 — Route `--device <lease>` through lease reuse

- Resolve registered devices and live lease slugs before ordinary host dispatch.
- Normalize an exact lease slug to the existing `leaseAndRun({ reuseBox: slug })` path — **not** raw SSH, which would skip workspace sync, isolated HOME, runtime install, account materialization, and cleanup.
- One bounded SSH readiness probe (`true`) before named dispatch and when computing live status → a stale "ready" becomes `unreachable`.
- Keep `--box`/`--bare` working; drop them from primary help/examples. **No new flag.**

### PR2 · area 5 — Truthful mesh (the "seamless" answer)

`computeNetMode` already exists (`exec.ts:277`): reuse → tailnet, one-shot → public. Change:

- Default a **new** lease to tailnet whenever the `tailscale.com` lease credential is configured; otherwise public, stated in output.
- `--tailscale` with no valid key **fails before provisioning** instead of silently downgrading to public.
- An existing named box keeps its real network; a run flag can't retrofit it.
- OAuth-client key minting stays out of scope; the current `agents devices lease setup` auth-key flow remains the credential contract, with a direct renewal error on expiry.

### PR2 · area 6 — Docs + delivery

- Update run/device help, README, concepts, profiles, hosts architecture, specifications, generated command reference, and CHANGELOG. Remove text claiming leases can't be addressed as devices.
- Audit + update companion `.agents-system` run/devices guidance in a linked PR (core-group sync rule).
- Open/claim an AGI ticket; link it both ways to this committed plan.

## Public Interface

```bash
# No new flag. The whole loop is existing surface:
agents run <agent> "<task>" --lease            # provision, run, keep warm on tailnet
agents devices list --all                      # leases now shown (text + --json)
agents run <agent> "<task>" --device <slug>    # reuse a warm leased box
agents devices lease stop <slug>               # release it

# Deprecated from help (still accepted): --box <slug>, --bare
```

## Validation

| Check | Expected result |
| --- | --- |
| Fresh `--lease` on real Hetzner | Agent runs; remote `~/.agents/.system` is a git repo; no native OAuth files present |
| Setup failure | Non-zero `97`, real cause surfaced, newly-created box stopped (not idle-billing) |
| Portable setup-token account | Accepted on a lease; native OAuth still refused before provisioning |
| `devices list --all --json` | Includes lease objects for every lifecycle state, even with zero registered devices |
| `run --device <slug>` | Reuses the same box/hostname; never warms a replacement; leases absent from `--device auto` |
| Tailnet default | New lease joins tailnet when key configured; labeled public otherwise; `--tailscale` w/o key fails pre-provision |
| Stop | Box leaves both the provider and `devices list --all` |

## Risks

| Risk | Mitigation |
| --- | --- |
| Stopping a box on bootstrap failure could kill a box the user wanted kept | Only stop boxes **this invocation created**; never an explicitly reused `--device`/`--box` slug |
| Live lease discovery on every `--all` adds latency / can fail | Bounded probe; discovery errors surface non-zero rather than silently dropping leases |
| Reusable tailnet auth keys expire (~90d) | Keep `agents devices lease setup`; emit a direct renewal error on expiry; OAuth-client minting is a separate follow-up |
| Name collision between a registered device and a lease | Resolve as ambiguous and instruct `--box <slug>` as the explicit lease selector |

## Checklist

- [x] Design approved
- [ ] PR1: deterministic bootstrap + setup-token classification (+ tests)
- [ ] PR1: merged on green
- [ ] PR2: leases as `--all`/`--device` devices + mesh + docs (+ tests)
- [ ] Real Hetzner acceptance run quoted on the PR
- [ ] Companion `.agents-system` guidance PR linked
- [ ] Released and installed version verified

## Tracking

- Plan: `.agents/artifacts/2026-08-25/plan-lease-first-class-devices.md`
- Ticket: _to be created under AGI and linked both ways_
