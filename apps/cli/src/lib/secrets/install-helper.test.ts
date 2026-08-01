/**
 * The keychain helper is a signed `.app` that ships only in a built npm tarball
 * — it is gitignored, and no CI runner ever has it. Code that merely *asks*
 * whether a keychain item exists must therefore survive its absence, because
 * that absence is a normal state on every machine running from source.
 *
 * These tests pin that contract by reproducing the real failure: with the
 * install root pointed at an empty directory and no source bundle in the tree,
 * `hasKeychainToken()` used to throw "Source Agents CLI.app not found" out of
 * `sourceAppPath()`, taking down `resolveProfileEnv`'s optional-auth skip and
 * `bundleExists()` with it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { keychainHelperAvailable, setInstallRootForTest } from './install-helper.js';
import { hasKeychainToken, getKeychainToken } from './index.js';

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

/** An item under our own service prefix — the branch that needs the helper. */
const OUR_MISSING_ITEM = 'agents-cli.no-such-provider-xyz.token';

/** Redirect the install root at a fresh empty dir so no helper can be found. */
function withEmptyInstallRoot<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-helper-absent-'));
  const prev = setInstallRootForTest(dir);
  try {
    return fn();
  } finally {
    setInstallRootForTest(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

darwinOnly('keychain helper availability', () => {
  afterEach(() => setInstallRootForTest(null));

  it('reports unavailable when neither an installed nor a source bundle exists', () => {
    // This working tree has no bin/Agents CLI.app and no built dist/, which is
    // exactly the state of a CI runner.
    withEmptyInstallRoot(() => {
      expect(keychainHelperAvailable()).toBe(false);
    });
  });

  it('hasKeychainToken returns false instead of throwing when the helper is absent', () => {
    withEmptyInstallRoot(() => {
      expect(() => hasKeychainToken(OUR_MISSING_ITEM)).not.toThrow();
      expect(hasKeychainToken(OUR_MISSING_ITEM)).toBe(false);
    });
  });

  it('getKeychainToken still throws when the helper is absent — a read must stay loud', () => {
    withEmptyInstallRoot(() => {
      expect(() => getKeychainToken(OUR_MISSING_ITEM)).toThrow();
    });
  });
});
