import * as yaml from 'yaml';

/**
 * The single serialization used by every writer that edits a shared, committed
 * YAML document in place.
 *
 * RUSH-2505 had two halves. The first: the `yaml` emitter pads flow collections
 * by default, so a round trip rewrote
 *
 *     command: [agents, notify, "{message}"]
 * as
 *     command: [ agents, notify, "{message}" ]
 *
 * The second, which outlived the first fix: `agents.yaml` has five in-place
 * writers, and they did not agree on collection style. `state.ts` and
 * `manifest.ts` forced block while `feed.ts`, `activity.ts` and `migrate.ts`
 * took the defaults, so an empty map came out as
 *
 *     mcp:            from two of them, and      mcp: {}
 *       {}                                        from the other three,
 *
 * and each group rewrote the other's output on the next command.
 *
 * Both diffs are semantically no-ops, which is what made them dangerous. The
 * working tree went permanently dirty, then `agents repo pull` refused
 * ("Blocked by local changes") and `git merge --ff-only` refused, so the box
 * silently stopped receiving fleet config. Seven boxes fell 37-52 commits
 * behind and nothing reported it.
 *
 * Routing every writer through one function is what fixes the second half: the
 * same document can only produce one result, so there is nothing left to
 * oscillate. `collectionStyle` is deliberately NOT pinned — forcing block would
 * flatten a committed flow sequence, which is its own dirtying diff and is
 * covered by a test in `feed.test.ts`.
 *
 * Caller options merge last, so a writer with a genuine reason to differ still
 * can — but it then owns the drift it causes.
 */
export function stringifyDoc(doc: yaml.Document, options: yaml.ToStringOptions = {}): string {
  return doc.toString({ flowCollectionPadding: false, ...options });
}
