- **New `agents secrets rotate-passphrase` re-keys the encrypted file store under
  a new master passphrase, atomically (RUSH-1975).** Until now there was no
  supported way to rotate the file-store passphrase — `rekey` only renames macOS
  keychain service names and `rotate <bundle> <key>` replaces a single secret
  value, so a leaked passphrase (RUSH-1968) could only be remediated by a
  hand-rolled non-atomic script or an export-to-plaintext round-trip (the exact
  exposure being fixed). The new command decrypts every `<item>.enc` under the
  current key, re-encrypts under a freshly generated one, and swaps both the
  ciphertext and the 0600 key file by directory rename after verifying every item
  round-trips — a crash at any point leaves the old store intact and readable, and
  no plaintext secret or passphrase is ever written to disk, argv, or a log. Items
  that don't decrypt under the current key (orphan caches, stale test artifacts)
  are carried through verbatim, never re-keyed. Dry-run by default (`--commit` to
  apply); refuses while the secrets-agent holds live unlocks or while
  `AGENTS_SECRETS_PASSPHRASE` is exported in the environment, unless `--force`.
  Headless-safe and Linux-first. Source: `apps/cli/src/lib/secrets/filestore.ts`,
  `apps/cli/src/commands/secrets-rotate-passphrase.ts`.
