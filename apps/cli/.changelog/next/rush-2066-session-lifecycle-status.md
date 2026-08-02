- **`agents sessions --active` now distinguishes dead and abandoned sessions
  (RUSH-2066).** The active-session engine computes lifecycle from PID liveness and
  transcript mtime: a dead process reports `closed`, a transcript stale for
  `ABANDONED_STALE_MS` reports `abandoned`, and a live opaque harness still reports
  `running` as its honest floor. The default list, grouped active tallies, and
  `agents hq floor` render `closed` / `abandoned` distinctly, and Factory maps
  `closed` to done and `abandoned` to failed so dead work no longer appears idle.
  Source:
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`,
  `apps/factory/src/core/remoteSessions.ts`.
