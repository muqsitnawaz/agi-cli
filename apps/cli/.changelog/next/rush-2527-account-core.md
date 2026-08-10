- **One account namespace for native logins and provider credentials (RUSH-2527).**
  `agents accounts name <agent[@version]> <name>` gives a durable name to a
  signed-in harness login — metadata only (a stable id + the identity fingerprint
  `sha256(agent\0identity)`, never a token or raw email), so the name follows the
  identity and survives version churn and shows in `agents accounts`. Provider
  credential accounts (`accounts add`) and native aliases now share one name
  namespace and one renderer for `accounts` / `accounts view <account>` (text and
  `--json`). New positional grammar reads object-first: `accounts view <account>`,
  `accounts attach <account> <harness>` / `detach <account> <harness>` (the
  harness-first `set-default` / `clear-default` remain as aliases), and
  `accounts sync <account> <device>`. `remove` refuses while a harness profile or
  a default binding still references the account, and a native alias reports it
  cannot be synced (native logins are per-device by design). Retired version-bound
  labels — the old `accounts.yaml` `labels:` map and any archived
  `accounts.legacy-labels.yaml` — are recovered into aliases by their preserved
  fingerprint on first read, then archived `.migrated` so it runs once. Source:
  `apps/cli/src/lib/account-aliases.ts`, `apps/cli/src/lib/account-catalog.ts`,
  `apps/cli/src/commands/accounts.ts`.
