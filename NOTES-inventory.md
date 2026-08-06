# RUSH-2238 resource inventory

- New module `apps/cli/src/lib/resource-inventory.ts` — the single inventory chokepoint:
  `getResourceInventory(agent, version, kind)` → `{ capable, declared, onDisk, wired, unmanaged, wiringSupported }`.
  Kind is harness-scoped; only `hooks` is implemented — other kinds throw a loud
  boundary error (structure is there for skills/commands/plugins/mcp follow-ups).
  Also exports `listOnDiskHooks(agent, { home, cwd })`, the one on-disk hook listing.
- `getAgentResources` (`apps/cli/src/lib/resources.ts`) now routes its hooks section
  through `listOnDiskHooks` — inspect/view get the inventory path for free.
- hooks.ts changes (minimal, same PR):
  - Extracted `getHooksDirInHome(agent, home)` — the RUSH-2237 absolute-hooksDir
    translation. `getVersionHooksDir` delegates to it, and
    **`listInstalledHooksWithScope` now uses it too** — path-fix only fixed
    `getVersionHooksDir`; the home-based join (old hooks.ts:773) still produced the
    broken hybrid path for grok/kimi, which kept `getAgentResources('grok', { home })`
    empty. One-line class of fix, same pattern.
  - `HookWiringReport` gained `wired: HookWiringIssue[]` (expected − unwired) so the
    inventory can report real wired refs without re-parsing settings.json.
- `wired[]` is populated for the settings.json family only (claude/droid/muse, via
  `checkVersionHookWiring`). **Grok hooks.json / Kimi config.toml wiring parsers are
  NOT implemented** — for those harnesses `wired: []` and `wiringSupported: false`
  (empty means "unknown", not "nothing wired"). That's the next teammate's job;
  the multi-harness wiring-check drift is spec D2 (`hooks.ts` SETTINGS_JSON_HOOK_FAMILY).
- `declared` = `listResources('hooks')` (layered repos), names normalized to
  extension-less install names so they compare with `onDisk`. `unmanaged = onDisk − declared`.
- Tests: `src/lib/resource-inventory.test.ts` (8 tests, fixture-backed, subprocess
  pattern like hooks.test.ts). Verify from `apps/cli`:
  `bun run vitest run src/lib/resource-inventory.test.ts --configLoader runner`
  (if `age-encryption`/`ws` module errors appear, run `bun install --frozen-lockfile`
  in apps/cli first — the worktree node_modules was incomplete).
- Env note: `openspec/` shows as untracked in this worktree — left alone.
- TODO for final PR assembler: CHANGELOG entry (grok/kimi `agents inspect` hook
  listing fix + new inventory API) — skipped here to avoid cross-teammate conflicts.
