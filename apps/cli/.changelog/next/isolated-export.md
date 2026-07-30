- **`agents export <agent>[@<version>]` — take an isolated install's config with you.**
  `--isolated` was a one-way door: it builds a self-contained home under the version
  dir and nothing ever brings that work back, so a user who configured a sandboxed copy
  for a week had to copy files by hand to promote it — or to leave. Export copies the
  isolated config dir out to the real `~/.<agent>`, stripping symlinks that point back
  into `~/.agents` so the result keeps working after agents-cli is gone. An existing
  real config is moved to `backups/<agent>/<ts>` rather than overwritten, a `~/.<agent>`
  that agents-cli already adopted is refused (writing there would mutate that version's
  home instead of the user's config), and `--dry-run` prints the exact plan. Only
  isolated versions are exportable — a normal install's config dir already *is*
  `~/.<agent>` via the adoption symlink. Source: `apps/cli/src/lib/export.ts`,
  `apps/cli/src/commands/export.ts`, `apps/cli/src/lib/config-transfer.ts`.
