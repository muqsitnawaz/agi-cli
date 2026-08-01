- **A missing keychain helper no longer breaks profiles and secrets lookups.** The signed
  `Agents CLI.app` ships only in a built npm tarball, so any machine running from source
  lacks it. `hasKeychainToken()` — a boolean existence probe — resolved the helper through
  `getKeychainHelperPath()`, which throws when the bundle is absent, so an optional-auth
  profile (`resolveProfileEnv`) and `bundleExists()` both died with `Source Agents CLI.app
  not found` instead of answering. The probe now reports an unreachable helper as "no
  item"; `getKeychainToken()` still throws, because a real read must stay loud. Source:
  `apps/cli/src/lib/secrets/install-helper.ts` (`keychainHelperAvailable`),
  `apps/cli/src/lib/secrets/index.ts` (`hasKeychainToken`).

- **PID-reuse protection now works on Windows.** `captureProcessStartTime()` had a `linux`
  branch and an else-branch shelling out to `ps`, which does not exist on Windows — so it
  always returned `null` there and every caller silently skipped the guard, letting a dead
  session whose PID had been recycled read as alive. Windows now reads `CreationDate` from
  `Win32_Process`. Source: `apps/cli/src/lib/pty-server.ts` (`captureProcessStartTime`).

- **A session's recorded working directory is no longer rebased onto the local drive.**
  `normalizeCwd()` ran `path.resolve()` over a cwd read out of a transcript, which may name
  a directory on another machine. On Windows that grafted the current drive onto a POSIX
  path (`/Users/me` became `D:\Users\me`), inventing a location that never existed. An
  already-absolute path is now passed through untouched; only a relative one resolves
  against the process cwd. Source: `apps/cli/src/lib/session/discover.ts` (`normalizeCwd`).

- **`agents cloud`'s task database can now be closed.** `cloud/store.ts` opened `tasks.db`
  and exported no closer, so nothing could release the handle — on Windows that leaves the
  file un-unlinkable. Adds `closeStore()`, the mirror of `closeDB()` in `session/db.ts`.
  Source: `apps/cli/src/lib/cloud/store.ts` (`closeStore`).
