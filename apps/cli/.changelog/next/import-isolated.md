- **`agents import <agent> --isolated` — bring your existing setup into a sandbox.**
  Isolation was a cold start: a new isolated copy began empty, and the only way to get
  settings into it was by hand. A plain `agents import` is the opposite of what is
  wanted here — it *adopts*, moving `~/.<agent>` into a version home, symlinking the
  original away, setting the global default and creating a shim (and is now refused
  outright for an isolated-only agent). `--isolated` copies instead: your settings land
  in the isolated home, your real config stays exactly where it is, and the version is
  finalized the way `agents add --isolated` does — versioned alias and marker, no
  default, no bare shim, no config symlink. Credentials are skipped by default and
  named in the output rather than silently included, since an isolated copy signs in as
  its own principal; `--with-auth` opts in. Symlinks into `~/.agents` are dropped so the
  copy does not depend on the CLI's tree. Source: `apps/cli/src/lib/import.ts`,
  `apps/cli/src/commands/import.ts`.
