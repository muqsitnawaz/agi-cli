---
type: fix
---

- **A leased box that fails `agents setup` now fails loud and is stopped, instead of silently dying after it's billed.** The lease bootstrap ran `agents setup >/dev/null 2>&1 || true`, discarding both the output and the exit code — so a fresh `agents run … --lease` whose setup failed marched on into a guaranteed agent failure and surfaced only a misleading `agents-cli is not set up`, after the box had already provisioned and started billing. Setup now runs visibly (it is already non-interactive with no TTY), aborts the bootstrap with exit `97` on failure, and asserts `~/.agents/.system/.git` exists before installing runtimes or launching the agent. A box **this run provisioned** that fails bootstrap (exit `96`/`97`) is now stopped so it doesn't idle-bill; a reused `--box`/warm-pool box is never auto-stopped. Source: `apps/cli/src/lib/crabbox/lease.ts`, `apps/cli/src/commands/exec.ts`.
