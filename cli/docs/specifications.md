# Behavioral specifications

These requirements are the stable behavior a refactor must preserve. Implementation
paths, commands, schemas, and known-gap ledgers do not belong here.

## Sessions

- A session-capable harness conversation MUST remain discoverable as a session.
- An execution record MUST link to a session when both exist and MUST NOT fabricate one
  when no conversation occurred.
- Live identity MUST remain distinct from durable transcript identity.
- Unavailable liveness evidence MUST NOT be reported as healthy.
- Rendering and sharing MUST redact by default; raw transcripts MUST NOT be published.

## Execution and fleet

- Every launch MUST pass through the common execution engine.
- Required context MUST survive local, team, routine, and SSH boundaries.
- Unsupported or unforwardable behavior MUST fail loudly before spawn.
- Automatic placement MUST use the shared resolver and MUST NOT fall back to a personal
  device when the eligible pool is empty.

## Scheduling singularity

- A fleet-affecting feature MUST have one scheduler and one executor.
- UI surfaces MUST NOT run acting timers or decision loops.
- Shared work MUST use an owner pin, atomic claim, or demonstrated idempotency.
- Routine scheduled-fire claims MUST be unique per `(routine, scheduledFor)`.

## Resources and secrets

- Resource precedence MUST be project, user, extra repositories, then system.
- Projection MUST be capability-gated and pruning MUST be limited to managed outputs.
- Declined writes MUST be visible as partial outcomes.
- Secret values MUST NOT be stored in a DotAgents repository.
- Injection and materialization MUST remain separate paths with consistent gates.

## Attention and watchdog

- Idle unfinished work MUST rank above healthy running work.
- `done` MUST remain distinct from `idle`.
- Answering or continuing an attention item MUST record a tombstone before clearing it.
- Watchdog delivery MUST target the owning device/session and record whether delivery
  succeeded.
