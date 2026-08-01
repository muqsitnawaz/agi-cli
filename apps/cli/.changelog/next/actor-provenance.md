- **Actor provenance — agent git commits are now credited to the human who
  started the run, not the shared account.** One account across a shared fleet
  meant every commit, from anyone who SSH'd into a box, showed up as the same
  author. `resolveActor()` now identifies who is behind a run: over SSH it
  `tailscale whois`es the client IP to the connecting tailnet identity (name +
  login email); locally it stays honest with `UNRESOLVED@<host>` and claims no
  identity. The resolved actor rides the agent's process env as `AGENTS_ACTOR` /
  `AGENTS_ACTOR_KIND` (inherited by the whole spawn tree, so it resolves once),
  and for a resolved human it also injects `GIT_AUTHOR_*` / `GIT_COMMITTER_*` — so
  the agent's own `git commit` is attributed to the person. An unresolved actor
  injects no git identity, so local runs keep their ambient git config unchanged.
  Source: `apps/cli/src/lib/actor.ts`, wired into `buildExecEnv`
  (`apps/cli/src/lib/exec.ts`).

- **Actor provenance now survives the SSH hop.** A run dispatched to another host
  (`agents run --host`, a remote `agents teams` supervisor, or any `--host`
  passthrough) used to drop the resolved actor at the SSH boundary, so the remote
  re-resolved it from the *originating* box's `SSH_CONNECTION` and mis-credited the
  work to the shared machine or `UNRESOLVED@<host>`. The dispatch layer now forwards
  `AGENTS_ACTOR*` / `GIT_*` across the wire (POSIX `export` and Windows `$env:`
  alike), so the remote inherits the origin identity instead of re-resolving. A
  caller-supplied env value still wins on collision (mirrors `buildExecEnv`).
  Source: `withActorEnv` in `apps/cli/src/lib/hosts/dispatch.ts`, wired into
  `launchDetached` / `runInteractiveOnHost` and the `--host` passthrough.

- **New optional `actors:` map in `agents.yaml`.** Keyed by a short slug, each
  entry (`kind` / `name` / `email` / `github` / `login`) enriches or overrides
  what `tailscale whois` resolves — pin a preferred git email, add a GitHub
  handle, override the display name, or mark an entry as an agent rather than a
  human. Entirely optional: a tailnet SSH identity already resolves without it.
  Source: `apps/cli/src/lib/types.ts` (`ActorConfig`, `Meta.actors`).
