# Orchestration

Teams coordinate several executions as a DAG. Each teammate owns its process, worktree,
conversation, and result; the team registry owns dependency and supervision state.
Boundary contracts state what an upstream task must deliver before a dependent task can
start.

Local and remote teammates use the same launch engine. Placement changes where a task
runs, not its identity, capability rules, or delivery contract. A remote teammate gets an
isolated worktree on its execution device and carries actor/session lineage across SSH.

Workflows are named compositions resolved through the resource layers and projected only
to capable harnesses. Subagents are declarative agent definitions projected through the
same registry-driven capability boundary. Neither creates a parallel execution engine.

Budget and stale-repository gates run before spawn. Supervisors may advance ready DAG
nodes, observe completion, and surface failure; they do not reinterpret a teammate's
conversation as the execution record.
