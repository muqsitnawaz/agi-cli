- **`agents view` no longer hides your own CLI behind an isolated install.** The listing
  was either/or per agent: any managed version at all suppressed the "Not Managed by
  Agents CLI" block, so a single `agents add <agent>@<v> --isolated` made the user's
  globally-installed CLI disappear from the one command they'd run to confirm
  `--isolated` had left it alone. Nothing on disk was ever touched — the isolation
  boundary holds — but the report read exactly like the damage it was supposed to rule
  out. Isolated copies now render alongside the global install and are tagged
  `9.9.4 (isolated)`; a normal (non-isolated) version still takes the launcher over and
  still suppresses the global row, since that row would just be our own shim. The global
  row is also resolved from PATH now (`getUnmanagedCliState`) instead of from the version
  dirs, which could otherwise report an isolated copy — deliberately unreachable from
  PATH — as `(global)`. Source: `apps/cli/src/commands/view.ts`, `apps/cli/src/lib/agents.ts`.
