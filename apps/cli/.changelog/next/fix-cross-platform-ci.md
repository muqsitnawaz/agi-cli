- **PID-reuse protection now works on Windows, from one implementation.**
  `captureProcessStartTime()` existed twice — in `pty-server.ts` and `teams/agents.ts` —
  and neither copy had a Windows branch: both fell through to `ps`, which does not exist
  there, so the function always returned `null` and every caller silently skipped the
  guard. A dead session whose PID the OS had recycled read as alive, and
  `agents teams stop` could signal an unrelated process group. Both copies now delegate to
  a single implementation in `platform/process.ts` that reads `CreationDate` from
  `Win32_Process` as a culture-independent FILETIME, memoizes per PID (the listing path
  probes one PID per row), and bounds the spawn with a timeout. Source:
  `apps/cli/src/lib/platform/process.ts` (`captureProcessStartTime`).

- **A session's recorded working directory is no longer rebased onto the local drive.**
  `normalizeCwd()` ran `path.resolve()` over a cwd read out of a transcript, which may name
  a directory on another machine. On Windows that grafted the current drive onto a POSIX
  path (`/Users/me` became `D:\Users\me`), inventing a location that never existed. A
  foreign path is now normalized with POSIX rules and never realpath'd; local paths still
  normalize and resolve symlinks as before. Source:
  `apps/cli/src/lib/session/discover.ts` (`normalizeCwd`).

- **`agents cloud`'s task database can now be closed.** `cloud/store.ts` opened `tasks.db`
  and exported no closer, so nothing could release the handle — on Windows that leaves the
  file un-unlinkable. Adds `closeStore()`, the mirror of `closeDB()` in `session/db.ts`.
  Source: `apps/cli/src/lib/cloud/store.ts` (`closeStore`).
