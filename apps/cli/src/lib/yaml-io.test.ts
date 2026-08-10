import { describe, it, expect } from 'vitest';
import * as yaml from 'yaml';
import { stringifyDoc } from './yaml-io.js';

/**
 * RUSH-2505. `agents.yaml` has five in-place writers; before this they emitted
 * different bytes for the same document, so the file flip-flopped and every
 * synced box went permanently dirty and silently stopped pulling.
 *
 * These assert the two properties that actually prevent that — the round trip
 * is byte-stable, and every writer agrees — rather than asserting the options,
 * so a future emitter default change still has to keep the bytes.
 */

/** The shape `agents.yaml` really has on disk, block-styled with an empty map. */
const COMMITTED = [
  '# Where a feed post is mirrored when it is worth interrupting someone over.',
  'feed:',
  '  broadcast:',
  '    owner:',
  '      command:',
  '        - agents',
  '        - notify',
  '        - "{message}"',
  '      minLevel: important',
  'registries:',
  // Block style renders an empty map on its own indented line; this is the
  // real on-disk shape, and the bare writers used to flatten it to `mcp: {}`.
  '  mcp:',
  '    {}',
  '  skill:',
  '    hermes:',
  '      url: https://example.invalid/skills.json',
  '',
].join('\n');

describe('stringifyDoc', () => {
  it('round-trips the committed agents.yaml shape byte-identically', () => {
    expect(stringifyDoc(yaml.parseDocument(COMMITTED))).toBe(COMMITTED);
  });

  it('is byte-stable when a writer edits one key', () => {
    const doc = yaml.parseDocument(COMMITTED);
    doc.setIn(['hooks', 'feed-publish'], { script: '10-feed-publish.py', timeout: 5 });
    const once = stringifyDoc(doc);
    // Everything the edit did not touch must survive verbatim.
    expect(once).toContain('  mcp:\n    {}');
    expect(once).toContain('        - "{message}"');
    expect(once).toContain('# Where a feed post is mirrored');
    // ...and re-emitting the result must be a fixed point.
    expect(stringifyDoc(yaml.parseDocument(once))).toBe(once);
  });

  it('makes all five agents.yaml writers emit identical bytes', () => {
    // state.ts and manifest.ts pass collectionStyle: 'block' explicitly;
    // feed.ts, activity.ts and migrate.ts pass nothing. Before RUSH-2505 those
    // two groups disagreed and rewrote each other's output forever.
    const explicit = stringifyDoc(yaml.parseDocument(COMMITTED), { collectionStyle: 'block' });
    const bare = stringifyDoc(yaml.parseDocument(COMMITTED));
    expect(bare).toBe(explicit);
    expect(bare).toBe(COMMITTED);
  });

  it('normalizes a legacy flow collection once, then holds it stable', () => {
    const legacy = 'a: [1, 2]\n';
    const first = stringifyDoc(yaml.parseDocument(legacy));
    expect(first).toBe('a:\n  - 1\n  - 2\n');
    // The one-time normalization must not turn into a loop.
    expect(stringifyDoc(yaml.parseDocument(first))).toBe(first);
  });

  it('never emits the padded flow form that started the drift', () => {
    const src = 'command: [agents, notify, "{message}"]\n';
    expect(stringifyDoc(yaml.parseDocument(src))).not.toContain('[ agents');
    // Guard the premise: the raw emitter still pads, which is why this exists.
    expect(String(yaml.parseDocument(src))).toContain('[ agents');
  });

  it('keeps comments and key order when a key is edited', () => {
    const doc = yaml.parseDocument('# keep me\na: 1\nb: 3\n');
    doc.set('b', 4);
    expect(stringifyDoc(doc)).toBe('# keep me\na: 1\nb: 4\n');
  });
});
