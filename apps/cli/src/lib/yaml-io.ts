import * as yaml from 'yaml';

/**
 * The single canonical serialization for a shared, committed YAML document.
 *
 * `agents.yaml` has five in-place writers — `state.ts`, `manifest.ts`,
 * `feed.ts`, `activity.ts` and `migrate.ts` — and before this they did not
 * agree on the bytes they emit. Two forced block style; three took the emitter
 * defaults. So the same key flip-flopped depending on which command last
 * touched the file:
 *
 *     registries:            vs      registries:
 *       mcp: {}                        mcp:
 *                                        {}
 *
 * and the emitter also pads flow collections by default, rewriting
 *
 *     command: [agents, notify, "{message}"]
 * as
 *     command: [ agents, notify, "{message}" ]
 *
 * Both diffs are semantically no-ops, which is what made them dangerous. The
 * working tree went permanently dirty, then `agents repo pull` refused
 * ("Blocked by local changes") and `git merge --ff-only` refused, so the box
 * silently stopped receiving fleet config. Seven boxes fell 37-52 commits
 * behind this way and nothing reported it (RUSH-2505).
 *
 * Pinning both options is what makes the round trip byte-stable: measured
 * against the real committed `~/.agents/agents.yaml`, `collectionStyle: 'block'`
 * round-trips and `flowCollectionPadding: false` alone does not. `block` is
 * also the shape already on disk, because `state.ts` and `manifest.ts` have
 * always written it — this makes the other three agree rather than inventing a
 * new format. `flowCollectionPadding` still matters for the collections block
 * style cannot flatten (an empty `{}` / `[]`).
 *
 * Every writer that edits a shared, committed YAML file in place must go
 * through here rather than calling `String(doc)` / `doc.toString()` directly,
 * so the shape is decided once instead of at each call site.
 *
 * Caller options merge last, so a writer with a genuine reason to differ still
 * can — but it then owns the drift it causes.
 */
export function stringifyDoc(doc: yaml.Document, options: yaml.ToStringOptions = {}): string {
  return doc.toString({ collectionStyle: 'block', flowCollectionPadding: false, ...options });
}
