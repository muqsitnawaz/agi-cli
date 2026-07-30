- **An isolated-only agent can no longer be adopted by anything.** `--isolated` used to
  be defined by what it *doesn't* do — no global default, no bare shim, no config
  symlink, no PATH edit — which meant every code path that could adopt an agent had to
  remember to check first. It leaked three times that way. Protection is now derived
  from the `.isolated` markers on disk (`isIsolationProtected`: at least one installed
  version, and every one isolated) and enforced inside the five primitives that can
  cross the boundary — `setGlobalDefault`, `createShim`, `switchConfigSymlink`,
  `switchHomeFileSymlinks`, `adoptShadowingLauncher` — so refusal is a property of the
  code rather than a convention. There is no mode to set and none to forget: installing
  with `--isolated` *is* the opt-in, it is per-agent, and the escape hatch is inherent
  (remove the isolated copies and the agent is ordinary again). `agents add`,
  `agents import` and `doctor --adopt` refuse with guidance rather than a stack trace —
  `import` is additionally checked at its entry point, because it registers the adopted
  install as a normal version *before* adopting, which would otherwise un-protect the
  agent underneath the primitive gate. Clearing a global default stays allowed, since
  removal legitimately clears one as an agent becomes isolated-only. A completeness test
  pins the primitive list and scans for any new ungated mutator. Source:
  `apps/cli/src/lib/shims.ts`, `apps/cli/src/lib/versions.ts`,
  `apps/cli/src/lib/isolation-boundary-report.ts`.
