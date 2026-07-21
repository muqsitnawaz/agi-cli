## Changed

- Compose project-scoped commands, skills, hooks, subagents, and MCP config into the current working directory for agents that natively load project resources, instead of flattening those entries into the shared version home.
- Keep project-only commands, skills, hooks, and subagents out of agent config unless a trusted same-name resource exists, and keep project MCP config behind the existing `agents mcp trust` gate.
