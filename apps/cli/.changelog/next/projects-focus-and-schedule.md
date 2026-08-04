- **`agents projects status` says what was worked on and what the dates prove.** Two new lines.
  `focus` ranks the directories the window's commits landed in, read from the local checkout
  with `git log --name-only` — no API call, no credential, no rate-limit budget, measured at
  0.23s over a 897-commit week. Changelog fragments and lockfiles are excluded from the
  ranking: this repo files one fragment per PR, so `.changelog` otherwise ranked second and
  presented PR count as an area of focus. `schedule` states what the milestone dates prove —
  `overdue by N days`, `due in N days`, `N milestones, no issues filed against any`, or
  `none dated`. Source: `apps/cli/src/lib/project-focus.ts`, `project-schedule.ts`.
- **The schedule line will never say "on track".** That verdict needs either project start and
  target dates to interpolate expected progress, or a scope-history series to extrapolate a
  finish date. Probed against a live workspace, all of them are absent (`health: null`,
  `startDate`/`targetDate` null, `scopeHistory` and `completedScopeHistory` empty), so an
  on-track or at-risk chip would be fabricated — and a confident wrong answer on a status card
  is unfalsifiable from the card. When a human posts a Linear project health update, it is
  relayed and attributed (`per Linear: atRisk`), never synthesized.
