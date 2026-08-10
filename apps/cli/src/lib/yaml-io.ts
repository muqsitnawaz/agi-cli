import * as yaml from 'yaml';

/**
 * Serialize a `yaml.Document` so that re-emitting an unchanged file is
 * byte-stable against what is committed.
 *
 * `yaml`'s emitter pads flow collections by default, so the format-preserving
 * round trip `parseDocument(src)` -> `String(doc)` rewrites
 *
 *     command: [agents, notify, "{message}"]
 * as
 *     command: [ agents, notify, "{message}" ]
 *
 * That diff is semantically a no-op, which is exactly what made it dangerous:
 * the first time the CLI touched a synced file the working tree went
 * permanently dirty, `agents repo pull` refused ("Blocked by local changes")
 * and `git merge --ff-only` refused, so the box silently stopped receiving
 * fleet config. Seven boxes fell 37-52 commits behind this way and nothing
 * reported it.
 *
 * Every writer that edits a **shared, committed** YAML file in place must go
 * through here rather than calling `String(doc)` / `doc.toString()` directly,
 * so the round trip stays byte-stable at one place instead of each call site
 * remembering an option.
 *
 * Caller options are merged last, so an explicit `collectionStyle: 'block'`
 * still wins; it only pins the padding default the caller did not set.
 */
export function stringifyDoc(doc: yaml.Document, options: yaml.ToStringOptions = {}): string {
  return doc.toString({ flowCollectionPadding: false, ...options });
}
