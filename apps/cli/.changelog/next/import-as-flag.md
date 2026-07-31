- **`agents import <agent> --as <version>` — the version flag now actually works.** The
  option was declared as `--version <version>`, which the program-level `.version(VERSION)`
  claims globally: `agents import codex --version 1.2.3` printed the CLI's own version and
  exited without importing. It had been unreachable since it was introduced, and the
  "could not determine version" error advised passing it. Renamed to `--as`, which reaches
  the command. This also makes `agents import <agent> --isolated --as <version>` re-seed an
  *existing* isolated copy from your current local config, instead of only ever creating a
  new copy at whatever version happens to be installed locally.
- **Fixed a silent no-op in config copying under the compiled binary.** `fs.cpSync` defaults
  to `force: true`, but Bun drops that default when a `filter` is supplied — so copies that
  strip symlinks left existing destination files untouched. `dist/bin/agents` is
  bun-compiled, so this affected a shipped path, not just tests. Now passed explicitly in
  `config-transfer.ts` and `import.ts`.
