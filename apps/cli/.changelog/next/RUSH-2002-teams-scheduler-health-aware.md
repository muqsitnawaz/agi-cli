- **`agents teams` auto-schedule is now health-, load-, and harness-aware (RUSH-2002).**
  A many-device pool's unpinned teammate no longer lands on whichever box has the
  fewest roster entries regardless of whether it is reachable, loaded, or can even
  run the requested harness. Cascade step 3 now reads the same cached fleet signals
  `agents fleet status` shows — DeviceStats (load/memory/headroom) plus the
  auth-health cache — with no fresh SSH in steady state (the daemon warms both), and:
  drops devices that are unreachable, overloaded (`headroom: loaded`), or at their
  `agents.max-concurrent` cap; drops devices that provably can't run the requested
  agent (the box was probed and the harness is absent or holds only a revoked token —
  a box with no cached data is kept, ranked after a proven-available one, so a cold
  cache never invents a false "can't run"); then ranks the survivors by (a) requested
  agent installed + signed in, (b) lower load/memory, (c) fewer running teammates.
  When no device in the pool can run the requested agent, `teams start` now fails loud
  — e.g. `No device in the team pool can run claude@2.1.112 (checked zion,
  yosemite-s0). Run 'agents fleet status --verbose' to see which harnesses each box
  has installed and signed in, or 'agents fleet login' to sign one in.` — instead of
  dispatching onto a box that cannot run it. A pinned `--device`, a pool of one, and a
  poolless team are unchanged; with no fleet data the pick still degrades to the old
  least-loaded behaviour. Source: `apps/cli/src/lib/teams/scheduler.ts`,
  `apps/cli/src/lib/teams/agents.ts`, `apps/cli/src/lib/auth-health.ts`.
