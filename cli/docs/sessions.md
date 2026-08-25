# Sessions

A session is a harness-native conversation plus a normalized, searchable projection.
The transcript is durable truth; the SQLite index and live registry are derived views.

## Data flow

Harness transcripts are discovered and parsed into normalized events. The index stores
search fields, provenance, resource usage, cost summaries, and links to execution
records. A content rescan may enrich missing fields but must not erase previously known
actor, lineage, or origin metadata.

Live identity answers which process owns a session now. It is ephemeral and distinct
from the durable transcript identifier. Harnesses coin identifiers differently, so the
launch id is the correlation seam across hooks and SSH rather than a fabricated universal
session id.

## Lifecycle

`running`, `waiting_input`, `idle`, `crashed`, `orphaned`, and `done` describe progress,
not merely process liveness. Finished work is terminal; idle unfinished work remains an
attention risk. Remote sessions remain owned by their origin device and are queried or
migrated through explicit transport.

Export, rendering, sharing, and migration operate on normalized events and redact by
default. Raw transcripts are never publishing artifacts.
