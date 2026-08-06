# RUSH-2239 hook wiring inventory

- `checkVersionHookWiring` now reads the three native formats owned by the existing registrars: Claude/Droid/Muse `settings.json`, Grok `.grok/hooks/hooks.json`, and Kimi `.kimi-code/config.toml` `[[hooks]]` entries.
- Expected entries are still derived from the layered manifest plus scripts present in the selected version home. Native config commands only count when their event, matcher, and command match that expected managed identity, so unrelated user hooks are not reported in `wired[]`.
- `getResourceInventory(..., 'hooks')` consumes the expanded report without a second parser. Its `wired[]` now works for Grok and Kimi as well as the settings.json family.
- `registerHooksToSettings` now resolves its version-local hook directory through `getHooksDirInHome`; this keeps the writer and read-only inspector on the same absolute-`hooksDir`-safe path for Grok and Kimi.
- Fixture coverage includes registrar-written Grok and Kimi configs, an unmanaged Grok command, and a live-sized Grok config containing 38 managed hooks.

Deferred harnesses:

- Codex has a straightforward `hooks.json` event/group shape in `apps/cli/src/lib/hooks.ts` (`registerHooksForCodex`), but effective wiring also requires `[features].hooks = true` and per-entry trust state in `.codex/config.toml`; reporting only the JSON reference would overstate hooks that Codex silently disables.
- Cursor has an event-renamed flat `hooks.json` shape in `apps/cli/src/lib/hooks.ts` (`CURSOR_EVENT_MAP` and `registerHooksForCursor`). It is outside the required Grok/Kimi/settings.json scope and should land with a fixture that pins every mapped event rather than piggybacking on this change.

Verify from `apps/cli`:

```sh
bun run vitest run src/lib/resource-inventory.test.ts src/lib/hooks.test.ts --configLoader runner
./node_modules/.bin/tsc --noEmit
```

Both commands passed in the shared worktree (19 tests). The repository build
script could not run in this managed sandbox because Bun could not write its
temporary install files; direct TypeScript compilation passed.
