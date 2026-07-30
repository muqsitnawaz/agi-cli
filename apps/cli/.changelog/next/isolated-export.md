- **`agents export <agent>[@<version>]` — take an isolated install's config with you.**
  `--isolated` was a one-way door: it builds a self-contained home under the version
  dir and nothing ever brings that work back, so a user who configured a sandboxed copy
  for a week had to copy files by hand to promote it — or to leave. Export is additive
  by default: it copies only paths you don't already have, and a collision is **not**
  silently skipped — the incoming file is written beside yours as
  `<name>.from-agents-cli` so you can `--diff` it and take the parts you want. Your
  files are never modified. `--replace` promotes a sandbox wholesale (yours is moved to
  `backups/<agent>/<ts>`, and it is the only mode that asks for confirmation);
  `--staged` dumps the tree into `~/.<agent>/.agents-export-<ts>/` and activates
  nothing. Every mode strips symlinks pointing back into `~/.agents` so the result
  keeps working after agents-cli is gone, keeps your own symlinks, and writes a receipt
  to `~/.<agent>/.agents-cli-export.json` recording exactly what came from the export —
  which makes "which of these files are mine?" answerable and the whole thing
  reversible. A `~/.<agent>` that agents-cli already adopted is refused, since writing
  there would mutate that version's home rather than your config. File *contents* are
  never auto-merged: the TOML parser here drops comments across parse+stringify, so
  unioning keys would silently delete them. Source: `apps/cli/src/lib/export.ts`,
  `apps/cli/src/commands/export.ts`, `apps/cli/src/lib/config-transfer.ts`.
