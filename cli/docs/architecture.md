# Architecture

agents-cli is the owning control plane. It installs and projects resources, launches
harnesses, records sessions and execution state, schedules automation, coordinates
devices, and exposes browser/computer tools. UI clients render CLI-owned state and call
CLI actions; they do not duplicate schedulers, stores, or decision engines.

## Process boundaries

- The one-shot CLI validates intent and talks to the owning service or store.
- The daemon owns long-lived services: scheduling, browser IPC, secret brokering,
  watchdog decisions, usage refresh, and read-model publication.
- Harness processes own native conversations and transcripts.
- Remote execution crosses SSH through the same command and environment contracts as
  local execution.
- AGI EXT and the menu bar are projections. They may poll read-only state and request
  actions, but never decide when to execute fleet-affecting work.

## State ownership

Durable transcripts remain harness-native. The session index is a rebuildable search
projection. Run/team/routine records own execution outcomes; they link to conversations
instead of replacing them. Device declarations and resource repositories are portable
configuration; caches and live-process registries are machine-local.

## Core invariants

1. Every agent launch enters the same execution engine.
2. One scheduler and one executor own each fleet-affecting action.
3. Shared work is claimed once or proven idempotent.
4. Unsupported capability and remote-boundary loss fail loudly.
5. UI state is derived from CLI truth, never maintained as a parallel mechanism.
6. A healthy running session is collapsed; unfinished non-progressing work is raised.
