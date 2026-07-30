- **`agents use <agent>@<isolated>` now works, and a bare `agents run <agent>` reaches
  your isolated copy.** Isolated installs were unreachable by name: `resolveVersion`
  ended at the global default, and an isolated install deliberately never becomes one —
  so `agents use` refused, and an isolated-only user had to type the full
  `agents run codex@0.144.6` every time while a bare `agents run codex` fell through to
  whatever `codex` meant on PATH. `use` now records an **isolated default** instead of
  refusing, and resolution falls back to it (`project pin -> global default -> isolated
  default`). Strictly a fallback, so nothing changes for anyone who has a global
  default. The pointer lives in `isolatedAgents:` in `agents.yaml`, never in the global
  `agents:` map — that separation is what keeps `getGlobalDefault` incapable of
  returning an isolated version, and with it the launcher, bare shim, config symlink and
  self-heal `shadowing` check all stay out of reach. It is verified on read and
  re-pointed (or cleared) on removal, so it can never resolve to a version that is gone.
  `agents view` labels it `(isolated default)`. Source: `apps/cli/src/lib/versions.ts`,
  `apps/cli/src/commands/versions.ts`, `apps/cli/src/commands/view.ts`.
