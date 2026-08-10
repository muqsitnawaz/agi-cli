# agents sessions — investigation artifacts (2026-08-10)

Friend-facing explainers for how `agents sessions` works: not shared memory,
local SQLite+FTS5 indexing, SSH cross-device query, export/import bundles.

| File | What |
| --- | --- |
| `agents-sessions-cross-device-index.html` | Full page: indexing, cross-device, filters, benches, SQLite live stats, export/import (primary) |
| `agents-sessions-explainer-2026-07-20.html` | Shorter “query tool not shared memory” explainer |
| `zion-week-sessions-2026-07-20.html` | Zion laptop week-of-work data story (sessions summary) |

Public share (when published): https://share.agents-cli.sh/agents-sessions-cross-device

Source investigation: agents-cli `lib/session/{discover,db,remote,remote-list,bundle}.ts`.
