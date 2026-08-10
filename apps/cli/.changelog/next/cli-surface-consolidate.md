- **CLI surface consolidation — nest or remove overlapping top-level commands.**
  - Synced vault unlock/lock moves to `agents secrets vault unlock|lock` (replaces top-level `login`/`logout`). Harness-native OAuth sign-out is `agents accounts logout <harness>` (API-key accounts keep `accounts remove`).
  - Spend caps live under `agents config budget` (was top-level `budget`).
  - Cost and shipped-output rollups nest under `agents insights cost` / `agents insights output`.
  - White-label manage verbs nest under `agents setup mine` (`init`/`list`/`toggle`/`remove`); top-level `mine` is gone.
  - Fleet poll snapshot moves to `agents devices snapshot` (not config).
  - Matrix runs use `agents run --broadcast` (with `--list-tasks` / `--results` / `--task`); top-level `bench` is removed.
  - Top-level `agents profiles` is removed — use `agents harness` (same `~/.agents/profiles/*.yml`).
  Source: `apps/cli/src/commands/{secrets-vault,accounts,budget,config,cost,output,insights,mine,setup-mine,snapshot,ssh,exec,run-broadcast,harness,profiles}.ts`, `apps/cli/src/lib/startup/command-registry.ts`.
