/**
 * Guard: `docs/secrets.md` must not teach the leak it documents a finding for.
 *
 * RUSH-1968 happened partly because the docs *recommended* the thing `agents
 * doctor` flags — the file-store section called an rc export "Recommended for
 * shared/CI machines" and called a 0600 key file "identical to" it. An operator
 * who followed the docs put a master key into `~/.zshenv` on seven boxes.
 *
 * Prose regresses silently, so these assertions read the shipped doc and pin the
 * few claims that must stay true. They deliberately check a small number of
 * specific strings rather than trying to lint English.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SECRETS_DOC = path.join(CLI_ROOT, 'docs', 'secrets.md');

function doc(): string {
  return fs.readFileSync(SECRETS_DOC, 'utf-8');
}

describe('docs/secrets.md hygiene (RUSH-1968)', () => {
  it('never recommends an rc-file export of the master passphrase', () => {
    const text = doc();
    // The exact phrasing that shipped the advice, plus the generic shapes it
    // would come back as.
    expect(text).not.toMatch(/Recommended for shared\/CI machines/i);
    expect(text).not.toMatch(/(add|put|place) .{0,40}AGENTS_SECRETS_PASSPHRASE.{0,40}(to|in) your (shell |login )?(rc|profile|~\/\.zshenv|~\/\.zshrc|~\/\.bashrc)/i);
  });

  it('never calls the 0600 key file equivalent to a shell-rc export', () => {
    // The inverted claim: the key file is strictly safer, because an rc export
    // is inherited by every child process. Saying they are the same is what
    // made the export look like a sanctioned choice.
    const text = doc();
    expect(text).not.toMatch(/identical to the common `?export AGENTS_SECRETS_PASSPHRASE/i);
    expect(text).toMatch(/is \*\*not\*\* equivalent to the 0600 key file/i);
  });

  it('names the real machine-local key path, not the pre-#479 co-located one', () => {
    const text = doc();
    expect(text).toContain('~/.agents/.secrets-key/passphrase');
    // The old path is fine to MENTION as legacy, but never as the live location
    // a reader should look at or chmod.
    expect(text).not.toMatch(/written to\s+`?~\/\.agents\/\.cache\/secrets\/\.passphrase/);
  });

  it('does not document a TTY passphrase prompt that getPassphrase no longer has', () => {
    // getPassphrase() "NEVER prompts and NEVER hard-fails" (filestore.ts).
    // A doc promising a prompt sends operators looking for a step that does not
    // exist, and implies the store needs a passphrase at all.
    const text = doc();
    expect(text).not.toMatch(/\*\*A TTY prompt\*\* — interactive sessions are asked for the passphrase/i);
    expect(text).toMatch(/never prompts and\s*\n?\s*never hard-fails/i);
  });

  it('points headless sync at the transport variable, not the master key', () => {
    const text = doc();
    expect(text).toContain('AGENTS_SYNC_PASSPHRASE');
  });
});
