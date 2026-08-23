- **`agents browser profiles edit`.** An existing profile's description,
  endpoints, secrets, viewport, and binary could not be changed without deleting
  and recreating it — `-d/--description` existed only on `create`, and
  `updateProfile()` had no CLI caller at all. `profiles edit <name>` reuses
  `create`'s flag spellings (minus `-b/--browser`, which keys the on-disk profile
  cache) and validates the merged record, so a binary edit re-resolves the
  browser path and a `--target-filter` edit re-checks the `--electron` gate.
  Source: `src/lib/browser/profiles.ts`, `src/commands/browser.ts`.
- **`profiles doctor` flags a profile that resolves to the wrong machine's
  browser.** A profile declared by one device but bound to `cdp://localhost:PORT`
  is evaluated on the machine running the command, so the name meant a different
  browser on every box — silently handing an agent a logged-out stranger instead
  of the credentialed profile it asked for. The check now names both the
  declaring device and this one. `ssh://` profiles are unaffected: they address a
  host, so they mean the same browser from anywhere.
  Source: `src/lib/browser/runtime-state.ts` (`identityLoopbackMismatch`).
- **Fixed: editing a profile's endpoint could collide with itself.** The local
  port scan `createProfile` runs was never applied on update, and applying it
  naively would have failed every edit against the profile's own stored port.
  Extracted as `assertLocalPortFree(profile, { ignore })` and now used by both.
  Source: `src/lib/browser/profiles.ts`.
