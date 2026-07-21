- **Ship the CLI surfaces the landing page implies.** Three commands now match the
  natural interface the docs advertise: `agents resources [--merged]` prints the
  merged resource surface (skills/commands/mcp/hooks/rules/plugins/workflows/subagents)
  resolved across the four config layers (project > user > system > extras), each
  row tagged with its winning layer (`--json` for machine-readable output); bare
  `agents devices` now defaults to `list` instead of printing help; and
  `agents plugins add` is a first-class alias of `agents plugins install`. Source:
  `apps/cli/src/commands/resources.ts`, `apps/cli/src/commands/ssh.ts`,
  `apps/cli/src/commands/plugins.ts`.
