- **`agents teams` no longer strands teammates on the silent-success path
  (RUSH-2356, RUSH-2366).** Three teammate-state defects that let a track report
  success while doing nothing:
  - **Retention reaped live `pending` teammates.** `listCompleted()` classified
    every non-`running` status as completed — including `pending` — so
    `cleanupOldAgents()` swept staged `--after` teammates past the 50-record cap.
    `teams add --after` printed a full success block and the teammate never
    launched. Retention now only ever deletes terminal (completed/failed/stopped)
    records, and `teams add` fails loud (non-zero exit) if the record is not
    durably on disk after the write.
  - **A rejected `teams add` left an orphan `agents/<name>` branch.** The worktree
    was created before dependency validation, so a duplicate name / missing
    `--after` dep left a branch that then broke the retry with `fatal: a branch
    ... already exists`. Adds now validate before creating the worktree, and tear
    it down if a later step fails.
  - **A dead teammate reported `RUNNING` forever and `resume` refused to relaunch
    it.** A `--device` teammate killed without writing its exit sentinel stayed
    `running` indefinitely, and a stale supervisor could re-persist `running` over
    an explicit `teams stop`. A gone-without-a-sentinel remote process is now
    reconciled to `failed` within a bounded time, a stale in-memory `running`
    never clobbers a newer on-disk terminal status, and stop-then-resume always
    relaunches.
  - **`agents message` could not reach a detached `--device --no-follow`
    dispatch.** It returned "No running agent or cloud task matches" for a run
    that was live with a pid. `agents message <name>`/`<session-id>` now resolves
    the host dispatch records `agents hosts ps` reads and either forwards the
    message to the host's mailbox over ssh or fails loud naming how to reach it.
  Source: `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/commands/teams.ts`,
  `apps/cli/src/commands/message.ts`, `apps/cli/src/lib/hosts/message-target.ts`.
