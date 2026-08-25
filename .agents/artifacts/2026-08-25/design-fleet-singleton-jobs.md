---
kind: plan
template: plan.v1
title: Two kinds of daemon job, and how the fleet picks who runs the shared one
summary: >-
  Usage is refreshed by every device independently — 88 provider calls a minute where 8
  would do. The daemon needs two job classes, and the shared one needs a lease held by a
  device chosen for stability, not by whoever asks first.
header: AGI CLI · fleet singleton jobs
footer: Phoenix Labs
project: agents-cli
context: >-
  Owner: 11 devices × 8 Claude accounts refreshed every minute is DDoSing the provider.
  It should run once, on a stable device — a desktop or Mac Mini, not a laptop that goes
  in a backpack — and be broadcast to the fleet. And the same pattern will be needed for
  routines and the watchdog.
repository: phnx-labs/agents-cli
branch: plan/reconnect-architecture
surface: cli
tracking: RUSH-3125
status: draft
harness: claude
agent: claude
human: Muqsit
host: zion
session: e9b853bc
date: '2026-08-25'
facts:
  - 'account-state-service.ts is documented device-local: every daemon refreshes usage every 60s'
  - 'withRefreshLease locks under getCacheDir() — same-device, cross-process only; nothing spans the fleet'
  - '11 devices × 8 accounts = 88 provider refreshes/minute where 8 would do'
  - 'The repo already has a real quorum-free fleet lease: release-lease.sh, holder + pid + liveness on a git ref'
  - 'Raft/quorum is wrong here — most devices sleep, so a majority is rarely online'
links:
  - title: RUSH-3125
    url: https://linear.app/prix/issue/RUSH-3125
assets: []
---

## Purpose

### What you should be able to expect — the behaviour, not the code

1. **My usage numbers are always current, and asking for them never costs a provider call.**
   Whatever device I sit at, `agents view` shows fresh usage instantly, because someone
   else already fetched it and shared it.
2. **The fleet calls the provider once per account per interval. Not once per device.**
   Adding a twelfth machine must not add a twelfth stream of API calls.
3. **The device doing the fetching is chosen for stability, not by luck.** A Mac Mini that
   never moves should beat a laptop that goes in a backpack. If I only own laptops, it
   still works — it just picks the best available.
4. **When the chosen device disappears, someone else takes over on their own**, within a
   bounded time, without me noticing and without me running a command.
5. **Two devices never do the shared job at the same time.** Not "rarely" — never, because
   double-fetching is what gets accounts rate-limited.
6. **A device that is offline, asleep, or on bad wifi degrades gracefully.** It shows the
   last known numbers clearly marked as stale, rather than either lying or blocking.
7. **Nothing about this requires most of my machines to be awake.** My fleet is mostly
   sleeping workers and closed laptops; a design needing a majority online is a design
   that does not work here.
8. **The same rule applies to every shared job**, not just usage — routines, the watchdog,
   anything reading a shared queue. I should not have to reason about each one separately.

### You were right, and I was wrong about the current state

I told you earlier that usage already used the elected-singleton pattern. **It does not.**
`lib/account-state-service.ts` opens with:

```ts
/** Device-local owner for usage snapshots and authentication health. */
export const USAGE_STATE_TICK_MS = 60_000;
```

Every device's daemon runs it, every 60 seconds, against
`https://api.anthropic.com/api/oauth/usage` (`lib/accounting/usage.ts`).

There *is* a lease — `withRefreshLease` in `lib/refresh-coordinator.ts` — but it locks
under `getCacheDir()`, a **local filesystem path**. It coordinates the daemon against an
explicit CLI refresh *on the same machine*. It has never spanned the fleet.

**So your arithmetic is the real arithmetic:**

| | today | needed |
| --- | --- | --- |
| Devices refreshing | 11 | 1 |
| Accounts each | 8 | 8 |
| Provider calls / minute | **88** | **8** |
| Calls / hour | **5,280** | 480 |

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> my previous design
said conflicts were impossible by construction. That was true only for device-owned facts,
and I let it stand as if it covered everything. Shared-input jobs are the case it does not
cover, and they are the case that actually hurts — because the penalty is not a data race,
it is your accounts getting throttled.</aside>

## Proposed Changes

### The two job classes, stated plainly

| | **Class A — device job** | **Class B — fleet job** |
| --- | --- | --- |
| Runs on | every device, independently | exactly one device |
| Input | that device's own processes/files | a **shared** resource — a provider API, a ticket tracker, a PR queue |
| Examples | session index, pid map, host-link, tab names, pane reaping | usage & rate limits, auth probes, routines on shared queues |
| Failure if you get it wrong | none — disjoint keys | **provider throttling, double-execution** |
| Needs | nothing | a lease + a broadcast |

Everything I designed previously was Class A. This is the Class B design.

### How the fleet picks who runs it

Three candidate mechanisms, and why the third one wins for your fleet:

| Approach | How it decides | Why not / why yes |
| --- | --- | --- |
| **Raft / Consul** | quorum of servers elects a leader | **No.** Requires a majority online. Your fleet is mostly sleeping workers and closed laptops — quorum would be unavailable most of the time. ([Consul consensus](https://developer.hashicorp.com/consul/docs/concept/consensus)) |
| **Leaderless P2P (Syncthing)** | nobody leads; every peer equal | **No.** Great for file convergence, but it has no "run this exactly once" concept — which is the entire requirement. ([Syncthing is peer-to-peer by design](https://knightli.com/en/2026/05/31/syncthing-multi-device-topology-guide/)) |
| **Lease with holder identity + TTL** | one writer claims a lease and must keep renewing it | **Yes.** No quorum. A dead holder is simply forgotten when its lease expires. This is what Kubernetes uses for exactly this problem. ([Kubernetes Leases](https://www.kubernetes.io/docs/concepts/architecture/leases/)) |

Kubernetes' `coordination.k8s.io/v1.Lease` is the reference implementation: a tiny record
of *"who holds this right now, and when does it expire"*, driven by three timers —
`LeaseDuration` (how long until a dead holder is forgotten), `RenewDeadline` (how long the
holder has to renew before it voluntarily stands down), and `RetryPeriod`. The property
that prevents split-brain is that **the holder gives up on its own** when it cannot renew,
rather than waiting to be told.

**And you already have a working one.** `apps/cli/scripts/release-lease.sh` holds
fleet-wide exclusivity by pushing an orphan commit to `refs/release-lock/held` on origin —
git's push rejection *is* the failed acquisition, so there is no second service to run. It
records holder host, pid and process start time, probes whether the holder is alive, and
distinguishes `dead` / `alive` / `unknown`. That is a real, battle-tested, quorum-free
lease **in your own codebase**. Generalising it beats inventing one.

### The part Kubernetes does not give you: not all devices are equal

K8s treats every replica as an equal candidate. Your fleet is not equal, and this is the
part that needs designing rather than copying.

```
                     eligibility to hold a fleet lease
  desktop / Mac Mini  ██████████████████████  always on, never moves, wired
  worker (yosemite-*) ████████████████        always on, but may be busy or reimaged
  interactive laptop  ████                    sleeps, moves, changes network
  offline / unknown   ·                       not a candidate
```

So the lease is not first-come-first-served. Acquisition is **weighted by device class**,
and the classes come from data you already have: `agents devices list` reports `role`
(`worker` / `personal`), an `interactive` marker, platform, and live reachability.

Concretely, the rule:

- A **better-classed** candidate may take the lease from a worse-classed holder at a
  renewal boundary — a graceful handoff, not a fight.
- An **equal-classed** candidate never preempts. Stability beats churn.
- The **interactive** device is the *last* resort, never preferred — it is the one in your
  backpack.
- With no desktop present, the best available worker wins; with only laptops, a laptop
  wins. It always resolves.

This needs one new piece of device metadata — something like `stability: always-on |
mobile` — because `role: worker|personal` conflates "agents may run here" with "this
machine is reliable". A Mac Mini you sit at is `personal` today but is the *best* lease
holder.

### Broadcast: the result is Class A once it is fetched

Once the holder fetches usage, the numbers are just another fact on the fleet stream. Peers
read them from the feed rather than calling the provider. Every consumer already knows how
to read that stream — it is the same `agents feed watch` pipeline the session rows ride.

Each published snapshot carries `fetchedAt` and `fetchedBy`, so a stale reader can say
*"usage as of 4m ago, from mac-mini"* instead of either lying or blocking. That satisfies
requirement 6 without a special case.

### Why this generalises

You suspected this pattern would recur, and the repo already says so:

> a job that consumes *shared* input (a ticket tracker, a PR queue, the feed, a sync
> bucket) MUST have exactly one executor per work item: an owner pin, an atomic claim per
> item, or verified idempotency — otherwise two daemons pick the same task and run it
> twice. — root `AGENTS.md`

That rule exists but is enforced by review, not by the code. Making Class B a **declared
property of a job** — with the lease and the broadcast supplied by the framework — turns a
convention people must remember into something the system does for them. Routines on shared
queues and the watchdog then get it for free.

## Public Interface

```bash
agents devices list                 # gains a stability column
agents devices stability <name> always-on|mobile
agents fleet lease                  # who holds each fleet job, since when, next renewal
agents view                         # unchanged — but never calls the provider on a follower
```

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <strong>Current — every device fetches, forever</strong>
<pre><code>zion         daemon → api.anthropic.com/oauth/usage × 8 accounts   every 60s
mac-mini     daemon → api.anthropic.com/oauth/usage × 8 accounts   every 60s
yosemite-s0  daemon → api.anthropic.com/oauth/usage × 8 accounts   every 60s
yosemite-s1  … m0 … m1 … m2 … m3 … m4 … m5 … m6

  88 provider calls / minute · 5,280 / hour · 11× more than needed</code></pre>
    <p><code>account-state-service.ts</code> is documented "device-local owner". The
    existing lease is under <code>getCacheDir()</code> — same machine only.</p>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>Proposed — one holder, chosen for stability, broadcast to the rest</strong>
<pre><code>$ agents fleet lease
  JOB            HOLDER     CLASS      HELD    RENEWS   STATE
  usage          mac-mini   always-on  4h12m   in 20s   ok
  auth-probe     mac-mini   always-on  4h12m   in 50s   ok
  routines:prs   mac-mini   always-on  4h12m   in 20s   ok

  zion (mobile) is not a candidate while an always-on device holds.

$ agents view                      # on any follower
  claude  team@…      42% used     usage as of 18s ago, from mac-mini</code></pre>
    <p>8 provider calls a minute for the whole fleet. A follower never calls the API — it
    reads the broadcast, and says how fresh it is.</p>
  </div>
</div>

## Validation

| Check | Expected |
| --- | --- |
| Count outbound provider calls fleet-wide for 5 min | 8/min total, not 88 |
| Unplug the lease holder | Another device takes over within the lease TTL, unprompted |
| Close the laptop lid | Nothing changes — it was never the holder |
| Only laptops online | One laptop holds it; the job still runs |
| Two daemons race at the same instant | Exactly one acquires; the loser does not fetch |
| Follower with no network | Shows last snapshot marked stale with `fetchedAt`, never blocks |
| Add a 12th device | Provider call rate unchanged |

## Risks

| Risk | Mitigation |
| --- | --- |
| Lease holder wedges — alive but not fetching | Renewal proves liveness of the *job*, not just the process: a holder that fails its fetch stops renewing and stands down |
| Clock skew across devices | Compare monotonic elapsed-since-renew, never absolute wall-clock, as the release lease already does |
| Preemption churn between two always-on devices | Equal class never preempts; only a strictly better class may take over |
| Followers hide a real auth failure behind a cached number | Publish `fetchedAt` + `fetchedBy` with every snapshot and surface staleness in the UI |
| Adding a Class B job without a lease | Make the class a declared field of the job so the framework supplies the lease — not a convention to remember |

## Checklist

- [x] Verify what usage actually does today (device-local, not elected — correction on record)
- [x] Research how this is solved elsewhere (K8s Lease · Consul/Raft · Syncthing)
- [x] Find the existing in-repo lease to generalise (`release-lease.sh`)
- [ ] Add `stability` to device metadata; surface in `agents devices list`
- [ ] Generalise the lease into a fleet-job primitive with holder + TTL + class-weighted acquisition
- [ ] Move usage/auth refresh onto it; publish snapshots with `fetchedAt` / `fetchedBy`
- [ ] Followers read the broadcast; remove the per-device provider call
- [ ] `agents fleet lease` for visibility

## Tracking

- [RUSH-3125](https://linear.app/prix/issue/RUSH-3125) · RUSH-3183 · RUSH-3180
- Prior session `476c260d` — where the daemon-level requirement was set
