- **`agents secrets` now tracks per-bundle usage and surfaces it.** A small local
  database at `~/.agents/secrets/secrets.db` records a value-free row every time a
  bundle is accessed (read/queried), imported, exported, or unlocked — never a
  secret value, only which bundle was touched, when, and by whom. `agents secrets
  view <bundle>` now shows whether the bundle is currently **unlocked** (held by the
  secrets-agent, so reads are prompt-free) and a **usage** summary ("accessed 42×
  (last 2h ago) · exported 3× (last 1d ago)"), and prints a **"No description
  found"** nudge for an undescribed bundle (also shown at `create` time).
  `agents secrets list` gains **`--sort name|used|uses|created|updated`** and
  **`--reverse`** to order bundles by how recently or how often they're used; the
  `--json` payloads carry `heldExpiresAt`, `usage`, and `uses`. Naming guidance is
  now taught in the help and skill: name a website bundle after its domain
  (`stripe.com`, `openai.ai`), a desktop-app bundle after its binary suffix
  (`slack.app`, `photoshop.exe`). Source:
  `apps/cli/src/lib/secrets/usage-db.ts`, `apps/cli/src/lib/secrets/audit.ts`,
  `apps/cli/src/commands/secrets.ts`.
