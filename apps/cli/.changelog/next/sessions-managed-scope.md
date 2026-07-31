- **`agents sessions` now lists what agents-cli manages, not your own installs.** Discovery
  scans the union of your real `~/.<agent>` and every managed version home, so once you had
  managed versions the listing mixed both — most visibly after `agents add --isolated`, where
  keeping the two apart was the whole point. Listing is now scoped to managed versions
  (isolated or not); `--unmanaged` brings your own installs back, and every render path prints
  what it hid (`N sessions from your own unmanaged installs hidden`) so nothing disappears
  silently. A user who has never run `agents add` sees exactly what they saw before — with
  nothing managed there is nothing to scope to. Scoping happens at query time rather than by
  narrowing the scan, so the index stays complete, `--unmanaged` needs no re-scan, and
  watchdog / `--roots` / the Factory watcher are unaffected. Source:
  `apps/cli/src/lib/session/discover.ts`, `apps/cli/src/commands/sessions.ts`.
