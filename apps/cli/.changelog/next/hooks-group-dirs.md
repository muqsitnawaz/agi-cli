- **Hooks: one-level group subdirs (e.g. `hooks/session-starts/`) are first-class.**
  SessionStart (and other event-family) scripts can live under `hooks/<group>/`
  while install names stay the file basename. Dirs with top-level scripts expand
  into individual hooks; fixture-only dirs (e.g. `tests/`) remain directory
  bundles. Source: `apps/cli/src/lib/hooks.ts`,
  `apps/cli/src/lib/staleness/writers/sources.ts`, `apps/cli/src/lib/versions.ts`,
  `apps/cli/src/lib/__tests__/hooks-nested-groups.test.ts`.
