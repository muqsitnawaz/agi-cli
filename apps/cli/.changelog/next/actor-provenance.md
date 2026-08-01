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

- **New optional `actors:` map in `agents.yaml`.** Keyed by a short slug, each
  entry (`kind` / `name` / `email` / `github` / `login`) enriches or overrides
  what `tailscale whois` resolves — pin a preferred git email, add a GitHub
  handle, override the display name, or mark an entry as an agent rather than a
  human. Entirely optional: a tailnet SSH identity already resolves without it.
  Source: `apps/cli/src/lib/types.ts` (`ActorConfig`, `Meta.actors`).
