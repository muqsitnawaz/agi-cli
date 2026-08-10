- **Unify native logins and provider credentials under one account model (RUSH-2527).**
  `agents accounts name <agent@version> <name>` gives a durable name to a
  harness's own signed-in login — metadata only in `meta.accounts.native` (a
  stable id + identity key + scope), never the harness's OAuth/session credential,
  which stays in the harness home. Native and provider accounts now share one name
  namespace and one `accounts` / `accounts view` renderer (text + `--json`). New
  positional grammar: `accounts name <source> <name>`,
  `accounts attach <account> <target>` / `detach <account> <target>`, and
  `accounts sync <account> <device>`. Attachment scope is harness-derived
  (`account-capabilities.ts`): a version-scoped harness (Claude/Codex/Grok/Muse)
  attaches to an exact `agent@version`; a device-scoped harness
  (Cursor/OpenCode/Antigravity/Kimi/Droid) attaches to the bare agent. `attach`
  validates the live identity before binding and injects no secret or env;
  `resolveAccountSelection` resolves explicit → exact-target binding →
  device-scoped binding → per-harness default. `remove` refuses while a binding, a
  default, or a harness profile still references the account. Source:
  `apps/cli/src/lib/account-registry.ts`, `apps/cli/src/lib/account-capabilities.ts`,
  `apps/cli/src/commands/accounts.ts`, `apps/cli/src/lib/types.ts`.
