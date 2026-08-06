# RUSH-2237 path fix

- Changed `getVersionHooksDir` in `apps/cli/src/lib/hooks.ts` to translate an absolute `hooksDir` into a path relative to the harness config directory before placing it in the version home.
- Added fixture-backed coverage in `apps/cli/src/lib/hooks.test.ts` for Grok and Kimi absolute paths, Claude's relative path, and nested event-directory discovery.

Verify from `apps/cli`:

```sh
bun run vitest run src/lib/hooks.test.ts --configLoader runner
```
