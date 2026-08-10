import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findAliasByName,
  findAliasForLogin,
  foldLegacyLabels,
  identityFingerprint,
  readNativeAliases,
  removeNativeAlias,
  renameNativeAlias,
  setNativeAlias,
} from './account-aliases.js';

describe('native login aliases', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-aliases-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('names a live login with a stable id and a fingerprint that matches the login', () => {
    const alias = setNativeAlias({ name: 'work', agent: 'claude', identity: 'claude:user=1' }, root);
    expect(alias.name).toBe('work');
    expect(alias.identity).toBe('claude:user=1');
    expect(alias.fingerprint).toBe(identityFingerprint('claude', 'claude:user=1'));
    const doc = readNativeAliases(root);
    expect(findAliasForLogin('claude', 'claude:user=1', doc)?.name).toBe('work');
    // A different identity on the same harness is not matched by this alias.
    expect(findAliasForLogin('claude', 'claude:user=2', doc)).toBeNull();
  });

  it('keeps the stable id when the same identity is re-named, and moves the name', () => {
    const first = setNativeAlias({ name: 'work', agent: 'claude', identity: 'claude:user=1' }, root);
    const second = setNativeAlias({ name: 'primary', agent: 'claude', identity: 'claude:user=1' }, root);
    expect(second.id).toBe(first.id);
    const doc = readNativeAliases(root);
    expect(Object.keys(doc.aliases)).toHaveLength(1);
    expect(findAliasByName('primary', doc)?.id).toBe(first.id);
    expect(findAliasByName('work', doc)).toBeNull();
  });

  it('refuses a name already used by another identity', () => {
    setNativeAlias({ name: 'work', agent: 'claude', identity: 'claude:user=1' }, root);
    expect(() => setNativeAlias({ name: 'work', agent: 'codex', identity: 'codex:user=9' }, root))
      .toThrow("Account name 'work' is already used");
  });

  it('renames preserving the id and removes cleanly', () => {
    const alias = setNativeAlias({ name: 'work', agent: 'claude', identity: 'claude:user=1' }, root);
    const renamed = renameNativeAlias('work', 'company', root);
    expect(renamed.id).toBe(alias.id);
    expect(findAliasByName('company', readNativeAliases(root))?.id).toBe(alias.id);
    removeNativeAlias('company', root);
    expect(Object.keys(readNativeAliases(root).aliases)).toHaveLength(0);
  });

  it('recovers an archived legacy-labels file into aliases, then archives it as migrated', () => {
    const fingerprint = identityFingerprint('claude', 'claude:user=1');
    fs.writeFileSync(path.join(root, 'accounts.legacy-labels.yaml'), [
      'labels:',
      '  work:',
      '    agent: claude',
      `    fingerprint: ${fingerprint}`,
      '',
    ].join('\n'));
    const doc = readNativeAliases(root);
    const alias = findAliasByName('work', doc);
    expect(alias).toMatchObject({ name: 'work', agent: 'claude', fingerprint });
    // The recovered label re-binds to the live login by its preserved fingerprint.
    expect(findAliasForLogin('claude', 'claude:user=1', doc)?.name).toBe('work');
    // Archived source moved so migration runs once.
    expect(fs.existsSync(path.join(root, 'accounts.legacy-labels.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'accounts.legacy-labels.migrated.yaml'))).toBe(true);
    // Idempotent: a second read leaves exactly one alias.
    expect(Object.keys(readNativeAliases(root).aliases)).toHaveLength(1);
  });

  it('folds labels without duplicating a name that already exists', () => {
    setNativeAlias({ name: 'work', agent: 'claude', identity: 'claude:user=1' }, root);
    const added = foldLegacyLabels({ work: { agent: 'claude', fingerprint: 'deadbeef' } }, root);
    expect(added).toBe(0);
    expect(Object.keys(readNativeAliases(root).aliases)).toHaveLength(1);
  });
});
