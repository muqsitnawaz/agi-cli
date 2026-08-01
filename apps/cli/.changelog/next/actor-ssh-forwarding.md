- **Actor provenance now survives SSH dispatch and teams.** Actor identity (and, for a
  resolved human, `GIT_AUTHOR_*` / `GIT_COMMITTER_*`) is now forwarded across the SSH hop
  for `agents run --host`, `agents ssh <host>`, and remote teammates, and teams local
  teammates inherit one frozen actor instead of re-resolving per teammate. Previously the
  actor was injected only into the local `buildExecEnv`, so a run dispatched to another
  host re-resolved to the originating box's tailnet identity (the shared account) instead
  of the human who launched it. Source: `apps/cli/src/lib/hosts/dispatch.ts`,
  `apps/cli/src/lib/teams/agents.ts` (RUSH-2028).
