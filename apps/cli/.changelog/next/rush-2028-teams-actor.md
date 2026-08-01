- **Teams now run local teammates under one frozen actor.** The orchestrator was
  spawning each local teammate through a raw shell without the actor env, so every
  teammate's inner `agents run` re-resolved the actor independently instead of
  inheriting the orchestrator's — contradicting the "resolve once, whole tree
  shares one actor" contract. The local spawn env now carries `actorEnv(resolveActor())`
  (process env < actor < `--env` overrides), so all teammates inherit the single
  frozen actor. Teammate records also carry an `actor` field, persisted to
  `meta.json` and emitted in the status dict. Remote teammates inherit the fix at
  the dispatch layer. Source: `apps/cli/src/lib/teams/agents.ts`.
