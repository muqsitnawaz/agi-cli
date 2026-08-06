- **`agents secrets setup` no longer tells you to set `AGENTS_SECRETS_PASSPHRASE`, and
  `docs/secrets.md` stops recommending the shell-rc export it flags as a leak
  (RUSH-1968).** The file-backend note read `set AGENTS_SECRETS_PASSPHRASE for headless
  encrypted-file reads`, implying a requirement; headless reads have worked with no
  passphrase since the store began auto-provisioning a 0600 machine-local key, so it now
  says so and names the real path. The docs were worse than merely stale: they called an
  rc export *"Recommended for shared/CI machines"* and the 0600 key file *"identical to"*
  it, which is how a master key ended up in `~/.zshenv` on seven worker boxes. That
  equivalence is inverted — the key file is read by one process, an rc export is inherited
  by every child and readable from `/proc/<pid>/environ` — and the section also named a
  pre-#479 key path (`~/.agents/.cache/secrets/.passphrase`, now
  `~/.agents/.secrets-key/passphrase`) and a TTY prompt step `getPassphrase` no longer
  has. A new `docs-hygiene.test.ts` pins those claims against the shipped doc so the
  advice cannot drift back. Source: `apps/cli/docs/secrets.md`,
  `apps/cli/src/commands/setup-secrets.ts`, `apps/cli/src/lib/secrets/filestore.ts`.
