# Observability

Observability is a set of projections over owned stores, not a second source of truth.

- Events are the unified operational and activity timeline.
- Sessions are conversations and live process identity.
- Feed is the operator attention ledger plus deliberate progress posts.
- Performance is a disposable latency warehouse.
- Insights derive behavioral and usage aggregates.
- Cost/output join token burn to durable delivery evidence.
- Doctor compares declared, installed, authenticated, and synchronized state.

Every event is stamped with machine, transport, caller, session, and resolved actor when
known. Provenance travels across child processes and SSH so a remote execution is not
misattributed to the shared machine account.

Attention is an explicit lifecycle. Resolution tombstones are recorded before an open
block clears, preventing stale session reads from resurrecting answered asks. The CLI
publishes one versioned stream; thin clients replace state on reset and apply monotonic
increments.

Health findings use one severity registry and one remediation vocabulary. A finding must
name a command that fixes the full scope represented by its row. Unavailable evidence is
reported as unknown or degraded, never healthy by default.
