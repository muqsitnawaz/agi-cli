# Concepts

## Resources and resolution

A resource is portable agent input: rules, commands, skills, hooks, MCP servers,
permissions, subagents, workflows, profiles, routers, secrets metadata, or host CLIs.
Resolution is layered: project overrides user, user overrides extra repositories, and
system is the lowest layer. Same-name entries override; different names union.

Resources are projected into harness-native formats only when the capability registry
says that harness and version support them. The registry is canonical; documentation
must not copy a capability matrix.

## Versions and harnesses

A harness is an agent integration. Pinnable harness versions use isolated version homes
so configuration cannot bleed between releases. Self-updating harnesses have one current
binary and must not acquire fictional version homes. Custom harnesses bind a host
harness, model, endpoint, and durable account while remaining a distinct launch target.

## Sessions and executions

A session is a conversation. A run, teammate, routine attempt, or cloud dispatch is an
execution. An execution may create a session; failed, skipped, missed, or command-only
executions may not. The records link when both exist.

## Devices, placement, and projects

A device is a registered machine and its connection facts. Placement selects where work
runs. A project is a named set of repositories and anchors; it supplies attribution and
execution context without owning a second scheduler or session store.
