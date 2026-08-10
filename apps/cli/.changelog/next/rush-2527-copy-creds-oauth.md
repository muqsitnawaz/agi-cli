- **`agents run --host --copy-creds` no longer copies a native OAuth / session
  login to another device (RUSH-2527, breaking for that flag).** It used to
  serialize each signed-in runtime's rotating login — the Claude OAuth token and
  codex/grok/gemini `auth.json` files — onto a persistent host so it booted
  logged-in. A rotating harness login copied across machines is invalidated on its
  next server-side token refresh and logs the rest of the fleet out, and the
  fleet-auth contract forbids it (`docs/specifications.md` SING-1b). `--copy-creds`
  now **fails loud** for any signed-in native runtime and steers to the portable,
  non-rotating path: create a provider account (`agents accounts add`) and push it
  with `agents accounts sync <name> --device <host>` (a policy-`never` bundle, safe
  to reuse on many devices). Explicit `agents accounts sync` and `secrets export
  --host` are unchanged. Source: `apps/cli/src/lib/hosts/credentials.ts`.
