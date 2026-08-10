import { describe, it, expect } from 'vitest';
import * as yaml from 'yaml';
import { stringifyDoc } from './yaml-io.js';

/**
 * RUSH-2505: `parseDocument` -> re-emit must be byte-stable on a file the CLI
 * only touched, or every synced box goes permanently dirty and silently stops
 * pulling. These assert the round trip, not the option — a future emitter
 * default change still has to keep the bytes.
 */
describe('stringifyDoc', () => {
  it('round-trips a flow sequence byte-identically (the agents.yaml notify entry)', () => {
    const src = 'notify:\n  owner:\n    command: [agents, notify, "{message}"]\n';
    expect(stringifyDoc(yaml.parseDocument(src))).toBe(src);
  });

  it('is what String(doc) is not — the padded form is the regression', () => {
    const src = 'notify:\n  owner:\n    command: [agents, notify, "{message}"]\n';
    // Guard the premise: if this ever stops padding, the helper is still
    // correct but this test's reason for existing has changed.
    expect(String(yaml.parseDocument(src))).toBe(
      'notify:\n  owner:\n    command: [ agents, notify, "{message}" ]\n',
    );
    expect(stringifyDoc(yaml.parseDocument(src))).not.toBe(String(yaml.parseDocument(src)));
  });

  it('leaves an untouched document byte-identical across nested flow collections', () => {
    const src = [
      '# leading comment',
      'hooks:',
      '  feed-publish:',
      '    agents: [claude, codex]',
      '    events: [PreToolUse]',
      '    timeout: 5',
      'devices: {a: 1, b: 2}',
      '',
    ].join('\n');
    expect(stringifyDoc(yaml.parseDocument(src))).toBe(src);
  });

  it('keeps comments and key order when a key is edited', () => {
    const src = '# keep me\na: [1, 2]\nb: 3\n';
    const doc = yaml.parseDocument(src);
    doc.set('b', 4);
    expect(stringifyDoc(doc)).toBe('# keep me\na: [1, 2]\nb: 4\n');
  });

  it('lets an explicit caller option win over the pinned default', () => {
    const src = 'a: [1, 2]\n';
    const doc = yaml.parseDocument(src);
    // state.ts / manifest.ts force block style on purpose; that must still work.
    expect(stringifyDoc(doc, { collectionStyle: 'block' })).toBe('a:\n  - 1\n  - 2\n');
  });
});
