import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyNativeAliases, groupNativeAccountRows } from './account-catalog.js';
import { readNativeAliases, setNativeAlias } from './account-aliases.js';

describe('native account catalog', () => {
  it('groups matching identities across versions without merging different harnesses', () => {
    const rows = [
      { agent: 'claude' as const, version: '2.1.1', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'claude' as const, version: '2.1.2', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'codex' as const, version: '1.0.0', accountKey: 'codex:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'claude' as const, version: '2.0.0', accountKey: 'claude:user=2', email: 'out@example.com', signedIn: false },
    ];
    expect(groupNativeAccountRows(rows)).toEqual([
      { kind: 'native', id: 'claude:user=1', agent: 'claude', display: 'a@example.com', email: 'a@example.com', versions: ['2.1.1', '2.1.2'] },
      { kind: 'native', id: 'codex:user=1', agent: 'codex', display: 'a@example.com', email: 'a@example.com', versions: ['1.0.0'] },
    ]);
  });
});

describe('applyNativeAliases', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-catalog-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('stitches a durable alias onto the identity it names and leaves the rest bare', () => {
    setNativeAlias({ name: 'work', agent: 'claude', identity: 'claude:user=1' }, root);
    const entries = groupNativeAccountRows([
      { agent: 'claude', version: '2.1.1', accountKey: 'claude:user=1', email: 'a@example.com', signedIn: true },
      { agent: 'claude', version: '2.1.2', accountKey: 'claude:user=2', email: 'b@example.com', signedIn: true },
    ]);
    const merged = applyNativeAliases(entries, readNativeAliases(root));
    expect(merged.find(e => e.id === 'claude:user=1')).toMatchObject({ alias: 'work' });
    expect(merged.find(e => e.id === 'claude:user=2')?.alias).toBeUndefined();
  });
});
