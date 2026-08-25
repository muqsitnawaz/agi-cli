# Agent execution

All launches converge on `buildExecEnv` and `execAgent` / `runWithFallback`. The engine
resolves harness and version, account, model/mode, project context, resources, actor and
session lineage, then replaces the launcher with the harness process where possible.

Local runs, device dispatch, teams, and routines must preserve the fields their target
needs. A value intended to reach the harness cannot disappear at the SSH boundary.

## Recovery

Native resume is valid only when the healthy origin version still owns the transcript.
Otherwise recovery launches a healthy version of the same harness and continues from the
indexed conversation. Recovery never silently changes harnesses.

## Interactive durability

Local interactive launches may run bare. A remotely interactive launch must survive link
loss and therefore requires its durable terminal transport unless the caller explicitly
opts out. An unavailable durability prerequisite fails before the harness starts.

## Failure contract

Missing binaries, unsupported modes, unavailable accounts, unsafe remote context, and
unforwardable options fail with a task-level explanation. No boundary returns success
after silently omitting required behavior.
