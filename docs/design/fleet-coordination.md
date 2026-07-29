# Fleet coordination & auto-placement — design

> Status: **design / RFC**. Nothing here is built yet. This doc argues an
> architecture for the "10 devices that coordinate themselves" scenario and
> weighs options before we write code. It leans hard on primitives that already
> exist in this repo — the whole point is that most of this is *lightweight glue*
> over SSH + Tailscale + the sync store, not a new distributed system.

## 1. The scenario

A single user has ~10 machines enrolled in their fleet (`agents devices`): a
couple of Macs, a Linux box or two, a Windows tower, maybe a leased cloud box or
two that come and go. Today the fleet is **push-driven from wherever you're
sitting**: `agents run --host mac-mini …` picks a host *by name*, `agents fleet
run` fans a command across *all* of them. There is no notion of "just run this
where it makes sense."

What we want:

1. **Auto host selection.** `agents run <prompt>` (no `--host`) should be able to
   pick the *best* host for *this project* — one that is online, has headroom, and
   already has the repo checked out — the same way `--balanced` already picks the
   best *cloud account*.
2. **Auto working directory.** Once a host is picked, the run should `cd` into
   that project's directory on that host automatically. We already pass
   `remoteCwd` through the dispatch path; what's missing is *where does the
   project live on host X* as data.
3. **A workspaces record.** An editable file under `.agents/` that maps a project
   to its candidate hosts and their checkout paths. The source of truth for #1/#2.
4. **Self-driving daemons.** The per-machine daemon should be able to *pull* work
   (not just fire local crons): when a task is queued for the fleet, some daemon
   picks it up. Machines disconnect and reconnect; a reconnecting daemon should
   catch up and grab unclaimed work.
5. **No double-execution, under skewed clocks, without a coordinator.** Two
   daemons must not both run the same task. We refuse to stand up Zookeeper/etcd/a
   metadata service. Peers *can* talk (SSH/Tailscale) and timestamp messages, but
   their wall clocks disagree — so correctness must not depend on comparing two
   machines' clocks.

## 2. What already exists (reuse inventory)

This is the reason the design can stay small. Everything below is in-tree today.

| Capability we need | Reuse | Where |
|---|---|---|
| Network fabric + presence | Tailscale (MagicDNS, online/direct/relay) | `devices/registry.ts` `DeviceTailscale`, `devices/tailscale.ts` |
| Transport + connection reuse | `sshExec*` + `ControlMaster` socket multiplexing | `ssh-exec.ts` (`controlOpts`, `cm-%C`, `ControlPersist=60s`) |
| Fan-out across machines | `planFleetTargets` / `runFleet` / `fanOutDevices` | `devices/fleet.ts` |
| Per-host load signal | `DeviceStats` (`loadPercent`, `memPercent`) → `headroom()` | `devices/health.ts` |
| Load signal, already warmed | daemon warms the stats cache every ~3 min | `daemon.ts` `runFleetCacheWarm`, `devices/stats-cache.ts` |
| **Load-balancing algorithm** | stateless **weighted-random-by-capacity**, no lock | `rotate.ts` `weightedRandomByCapacity` / `selectBalancedVersion` |
| Host directory behind a seam | `HostProvider` capability-gated registry (`local`, `devices`; `rush`/`crabbox` called out as fast-follows) | `hosts/types.ts`, `hosts/registry.ts` |
| Placement resolution | `resolveHostRunTarget` → name → **capability tag** | `hosts/run-target.ts`, `resolveHostByCap` |
| Dispatch that survives disconnect | detached `nohup`-style launch + remote `.log`/`.exit` | `hosts/dispatch.ts` `launchDetached` |
| Remote working directory | `remoteCwd` threaded end-to-end | `hosts/run-target.ts`, `hosts/remote-cmd.ts` |
| **One-owner-across-nodes** | file-lease + pid-liveness + **last-rename-wins** re-read | `apps/factory/src/monitor/lease.ts`, `leader.ts` |
| Single-instance + heartbeat + **self-heal takeover** | `O_EXCL` lock, heartbeat file, "take over only if nobody healthy answers" | `daemon.ts` (`acquireStartLock`, `shouldTakeOverBroker`) |
| Data-loss-safe registry writes | `proper-lockfile` + atomic tmp+rename | `devices/registry.ts` |
| **Append-only log that merges with zero conflicts** | **G-Set CRDT**, union by content hash, deterministic (ts,hash) order | `session/sync/crdt.ts` |
| Shared cross-machine store | R2 / S3-compatible object store (already the session sync backend) | `session/sync/{r2,config,sync}.ts` |
| TOCTOU-safe "is this stale" check | freshness window on `lastTouchedAt` before reaping | `crabbox/cli.ts` `isReapSafe` |
| A daemon that already *pulls* work | `autoDispatchTick` polls Linear, dispatches capped-per-project | `daemon.ts`, `auto-dispatch.ts` |

Two genuine gaps, both by omission not by obstacle:

- **No shared cross-machine task queue.** Host tasks (`hosts/tasks.ts` JSON
  sidecars), cloud tasks (`cloud/store.ts` SQLite), and routines (daemon
  `JobScheduler`) are three *per-machine* stores. Nothing spans the fleet.
- **No `workspaces` abstraction.** Closest things are layered repos, git
  worktrees under `.agents/worktrees/`, and the cloud pod's `/workspace/<owner>/<name>/`.

## 3. Requirements & non-goals

**Functional**

- Pick a host for a run automatically from {online, has-headroom, has-the-repo}.
- Auto-`cd` to the project's checkout on the chosen host.
- An editable `.agents` file is the source of truth for project→host→path.
- A daemon can claim and run a fleet-queued task; a reconnecting daemon catches up.

**Correctness under a weak network**

- **At-least-once**, not exactly-once. We will *bound* duplicate execution to a
  short race window; we will not claim to prevent it absolutely (that needs
  consensus, which we're rejecting). Agent runs are the unit of duplication and
  are mostly idempotent-at-worst (a duplicate PR, not corrupted state).
- **Clock-skew-immune ownership.** No ownership or liveness decision may compare
  two machines' wall clocks. (See §5.)
- **No thundering herd on the store.** Steady-state coordination must not require
  every daemon to hammer the store on a synchronized tick.

**Non-goals**

- No Zookeeper / etcd / Consul / a bespoke metadata daemon.
- No strong consistency, no linearizable queue, no leader-of-the-whole-fleet.
- No new network fabric — Tailscale + SSH only.
- Not trying to schedule *across users/orgs*. One user's fleet.

## 4. Where the coordination state lives — three options

The central question is **what is the shared source of truth** for "these tasks
exist and this one is claimed by zion." Everything else (placement, cwd) is local
computation over data. Three shapes:

### Option A — Store-as-log (poll the shared object store)

The R2 bucket (already there for session sync) also holds a fleet **coordination
log**: an append-only set of task-intent and claim records. Each daemon polls on
a jittered interval, merges via the existing G-Set CRDT, and acts.

- **Pros:** Reuses the exact sync substrate and CRDT we already ship. Survives
  arbitrary disconnection — the store *is* the rendezvous, no peer needs to be up.
  A reconnecting daemon just re-syncs. Dead simple mental model.
- **Cons:** Latency = poll interval (seconds, not ms). Every daemon polling the
  same bucket is load on the store and risks a synchronized stampede (mitigate
  with jitter + conditional GET/ETag). The store is a single dependency —
  if R2 is down, no new work is picked up (existing runs keep going).

### Option B — Peer gossip (no store, SSH/Tailscale only)

Daemons discover each other from the device registry and gossip state directly
over SSH/Tailscale: "here's what I'm running, here's what I claim." No shared
store in the hot path.

- **Pros:** Low latency, no store dependency, no store load. Uses the SSH reuse we
  already lean on. "Devices send each other timestamped messages" — literally this.
- **Cons:** Requires a connected component to make progress; a machine that was
  *offline while a task was queued* has no rendezvous to learn about it from.
  Gossip convergence + anti-entropy is real distributed-systems surface area — the
  thing the user explicitly doesn't want to over-build. Membership/partition
  handling is on us.

### Option C — Hybrid: store is the log-of-record, peers are the fast path *(recommended)*

The **store holds durable intent + claims** (low frequency, source of truth for a
reconnecting or offline-missed machine). **Peers exchange liveness and
hand-offs directly** over Tailscale/SSH (fast path, keeps the store cool). A
daemon claims in the store, then announces to peers directly so they react in
ms instead of on their next poll; the store poll is the safety net + the
cold-start / reconnection path.

- **Pros:** Gets Option A's durability and reconnection story *and* Option B's
  latency, while keeping store load low (peers don't need to poll fast because
  they get pushed). Degrades gracefully: peers down → fall back to store polling;
  store down → existing claims keep running, new claims wait. Each half is
  independently the "don't tread *only* to the store" the user asked for.
- **Cons:** Two paths to keep consistent. We accept that by making the **store
  authoritative** — the peer channel is an *optimization/notification*, never a
  source of truth. A hand-off that a peer missed is caught by the next store poll.

**Recommendation: C**, because it's the only one that satisfies both "survive a
machine that was offline when work appeared" (needs a store) and "don't make the
store the only channel / don't stampede it" (needs peers) at once — and both
halves are already-in-tree primitives (R2+CRDT for the store, `sshExec` for peers).

## 5. The clock-skew answer (the actual hard part)

The user is right that this is the classic trap. Our rule:

> **Wall-clock timestamps are for humans. Ownership and liveness use logical
> counters and *self-measured* elapsed time only.**

Concretely, a **claim/lease record** looks like:

```jsonc
{
  "taskId": "t_9f2…",
  "holder": "zion",        // machineId of the claimant
  "epoch": 7,              // monotonic counter, bumped on every (re)claim/renew
  "holderPid": 48213,      // liveness cross-check when holder is reachable
  "stampedAt": "2026-07-29T18:40:00Z"  // WALL CLOCK — display only, never compared across machines
}
```

Two decisions, neither of which compares two machines' clocks:

1. **"Is the holder still alive?"** The holder renews by **bumping `epoch`** on its
   own tick. Any observer remembers *"I last saw epoch=7 at my-local-time T_local"*
   — and decides the lease is dead only if `epoch` hasn't advanced within a grace
   window **measured on the observer's own clock** (`now_local − T_local >
   graceMs`). This is skew-immune: we compare *our own* clock delta against a
   *remote counter's* movement, never their timestamp against ours. It's the same
   idea as the factory leader's heartbeat renew (`leader.ts`), generalized from a
   local file to the shared record, using a counter instead of `expiresAt` so a
   fast/slow remote clock can't grant or steal a lease early.

2. **"Two daemons claim the same free task — who wins?"** Reuse the factory
   **last-rename-wins / read-after-write** convergence (`leader.ts` `tick`): write
   your claim, re-read the record, and if you don't see *your own* `holder`/`epoch`,
   you lost — back off. On R2 this becomes a **conditional write** (S3/R2 now
   support `If-Match`/`If-None-Match` ETags), which is a real compare-and-swap and
   collapses the race to a single round trip. If we'd rather not depend on
   conditional writes, the read-after-write + higher-`(epoch, holder)`-wins tie-break
   converges without them — at the cost of a slightly wider dup window.

**Honest failure mode:** a network partition where two daemons each believe the
other is dead will let both run the task once (at-least-once). We accept and
document this rather than reach for consensus. The blast radius is "a task ran
twice," bounded by the lease grace window, and further reducible by making
dispatch idempotent on `taskId` (a run tagged with the task id is a natural dedup
key downstream, e.g. the PR title).

Note the existing CRDT (`session/sync/crdt.ts`) already sorts by `(timestamp,
hash)` — that ordering is only for *deterministic display convergence* of an
append-only set, not for correctness, so its use of wall-clock timestamps is fine
and we keep it.

## 6. Recommended design (Option C, concretely)

### 6.1 The workspaces file — `~/.agents/workspaces.yaml`

Placed in the **user repo** (top-level, *synced* — unlike `devices/registry.json`
which is deliberately machine-local under `.history/`), so every machine sees the
same map. Editable by hand; `agents workspaces …` maintains it.

```yaml
# ~/.agents/workspaces.yaml
workspaces:
  agents-cli:                         # logical project id
    repo: github.com/phnx-labs/agents-cli   # identity used to auto-match a cwd → workspace
    hosts:                            # candidate hosts + where the repo lives on each
      zion:        { path: ~/code/agents-cli }
      mac-mini:    { path: ~/Phoenix/agents-cli }
      win-tower:   { path: C:\src\agents-cli }
    placement: balanced               # balanced | pinned:<host> | first-available
    caps: [fast-disk]                 # optional: require hosts carrying these tags
```

- **Auto-cwd** falls straight out: pick host `zion` → `remoteCwd = ~/code/agents-cli`,
  threaded through the dispatch path that already accepts `remoteCwd`. No new
  transport work.
- **Auto host selection** = filter `hosts` to {online (Tailscale), dispatchable,
  headroom ≠ loaded, has the repo path}, then run them through the *existing*
  `weightedRandomByCapacity` with weight = headroom instead of account capacity.
  This is the same function `--balanced` uses for cloud accounts — the user's
  "what about balancing between hosts?" is literally the account balancer pointed
  at `DeviceStats`.
- Membership is inferred, not hand-maintained: a bare `agents run` from inside a
  git repo matches `repo` → workspace; unmatched falls back to today's behavior.

### 6.2 Placement: extend `resolveHostByCap`, don't replace it

`resolveHostByCap` today treats "multiple hosts match this tag" as an **error**
(`Multiple hosts tagged…`). The one-line-of-intent change: when a workspace (or a
`--host <tag>`) resolves to multiple candidates, **don't error — weighted-pick by
headroom** from the daemon-warmed stats cache (already fresh, no probe needed on
the hot path). Ambiguity becomes load-balancing. `pinned:<host>` keeps today's
exact behavior for people who want it.

### 6.3 The fleet task log + claims (store-as-record)

A new coordination prefix in the existing bucket, e.g. `fleet/tasks/` and
`fleet/claims/`, written and merged with the **existing CRDT machinery**:

- **Enqueue** (`agents fleet queue <prompt> --workspace agents-cli`) appends a
  task-intent record (grow-only set — never mutated, so CRDT-union-safe).
- **Claim** writes a lease record (§5) via conditional write; the winner
  dispatches locally through the *existing* `dispatchPromptToHost` and records the
  resulting `HostTask`.
- **Complete/fail** appends a terminal record; GC prunes settled tasks (reuse the
  `isReapSafe` freshness-window shape from crabbox so we never prune a task a peer
  just touched).

Daemons run a `fleetPullTick` next to the existing `autoDispatchTick` and
`runFleetCacheWarm` — the daemon **already has a "poll for work and dispatch"
loop**, so this is a sibling, not a new subsystem. Poll interval is jittered
per-machine to avoid a synchronized stampede on the bucket.

### 6.4 The peer fast-path (keep the store cool)

On claim/complete, the claimant fires a best-effort direct notification to online
peers over the SSH reuse we already have (`fanOutDevices` + a tiny `agents fleet
notify` receiver, or writing into the peer's existing `mailbox/`). Peers treat it
as a *hint to re-sync now* rather than as truth — so a missed/forged notification
only costs a little latency, never correctness. This is what lets the store poll
be slow (30–60s) without making hand-offs feel slow.

### 6.5 Reconnection & disconnection

- A daemon starting or reconnecting does a full store sync (CRDT merge) → sees all
  open tasks and current claims → claims anything free/expired. This is the
  "auto pick up tasks" behavior, and it's just the cold-start path of the same
  loop.
- A daemon going away stops renewing `epoch`; its leases age out by the
  self-measured grace window on every observer, and the work is re-claimed. Same
  shape as the daemon's existing broker self-heal takeover.

## 7. New / changed surfaces

| Surface | New or reuse |
|---|---|
| `~/.agents/workspaces.yaml` + loader/validator | **new**, small; mirror `devices/registry.ts` atomic+lock write discipline |
| `agents workspaces add/list/set` | **new** thin command |
| Weighted-by-headroom host pick | **extend** `resolveHostByCap` + reuse `weightedRandomByCapacity` |
| `agents run` auto-host when workspace matches cwd | **extend** `exec.ts` `--host` branch |
| `fleet/` CRDT prefix in the bucket | **reuse** `session/sync/{r2,crdt,sync}.ts` |
| Lease/claim record + conditional write | **new** small module; **reuse** `factory/monitor/lease.ts` decision logic |
| `fleetPullTick` in the daemon | **new** loop, sibling of `autoDispatchTick` |
| `agents fleet queue/notify` | **new** thin commands |

## 8. Phasing (so we don't over-build)

1. **Workspaces + auto-cwd + auto host pick.** No queue, no daemon changes. `agents
   run` from a known repo picks the best online host with the checkout and `cd`s
   in. This delivers most of the felt value and is ~pure reuse (`workspaces.yaml`
   + headroom weighting + existing `remoteCwd` dispatch). Ships alone.
2. **Fleet task log (store-as-record) + claims.** Enqueue a task, exactly one
   daemon claims and runs it, GC settles it. Store-only (Option A) first — simplest
   correct thing.
3. **Peer fast-path + reconnection polish.** Add the direct-notify optimization and
   the jitter/backoff tuning. This is the Option A→C upgrade, and it's optional:
   the system is *correct* after phase 2, phase 3 only makes it *snappy and cheap*.

Stopping after phase 1 is a legitimate product. Phases 2–3 are only worth it once
people actually queue fleet work rather than target a host by name.

## 9. Open questions (need a call before phase 2)

1. **Workspace scope:** is `workspaces.yaml` per-user-fleet (my recommendation,
   synced in the user repo) or should a project ship its own default in the
   *project* `.agents/`? (I lean user-repo; project-repo can hold a checked-in
   *suggestion* that seeds it.)
2. **Conditional writes:** do we depend on R2/S3 `If-Match` ETag CAS (one
   round-trip claim, tightest race window), or stay portable with read-after-write
   convergence (no special store support, slightly wider dup window)?
3. **Exactly-once appetite:** are we content documenting at-least-once with an
   idempotent `taskId` dedup key, or is even a rare double-run unacceptable for the
   target workloads (which would force a real coordinator and change this whole
   doc)?
4. **Leased boxes as claimants:** should an ephemeral crabbox lease be allowed to
   *claim* fleet tasks, or only *receive* placements? (Reaping vs. an in-flight
   claim needs the `isReapSafe` window to also respect an active lease record.)
