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

const RC_FILES = String.raw`~/\.(zshenv|zshrc|bashrc|bash_profile|profile)|shell rc|login shell|shell profile|login profile`;

/** Sentences mentioning the master passphrase, so a check can look at the claim
 *  in context instead of matching one exact turn of phrase. */
function sentencesMentioningMasterKey(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .filter((s) => s.includes('AGENTS_SECRETS_PASSPHRASE'));
}

describe('docs/secrets.md hygiene (RUSH-1968)', () => {
  it('never recommends putting the master passphrase in a shell rc file', () => {
    const text = doc();
    expect(text).not.toMatch(/Recommended for shared\/CI machines/i);

    // Match on MEANING, not one turn of phrase: any sentence that both names a
    // shell rc file and reads as an instruction to persist the variable there.
    // The narrow first draft of this check would have passed "export
    // AGENTS_SECRETS_PASSPHRASE in ~/.zshenv" and "persist it in the login
    // profile" — the exact advice that caused RUSH-1968.
    const persistVerb = /\b(add|put|place|persist|set|export|store|keep|save|source)\b/i;
    const offenders = sentencesMentioningMasterKey(text).filter(
      (s) => new RegExp(RC_FILES, 'i').test(s) && persistVerb.test(s),
    ).filter(
      // The doc must be able to WARN about the rc export, and describe the
      // legitimate per-command `export … ; unset` shape. Exclude sentences that
      // are clearly prohibitions or refer to the transient form.
      (s) => !/\b(never|not|do not|don't|avoid|warn|leak|inherited|flags|unset|instead of)\b/i.test(s),
    );
    expect(offenders).toEqual([]);
  });

  it('never calls the 0600 key file equivalent to a shell-rc export', () => {
    // The inverted claim: the key file is strictly safer, because an rc export
    // is inherited by every child process. Saying they are the same is what
    // made the export look like a sanctioned choice — in ANY phrasing.
    const text = doc();
    const equivalence = /\b(identical|equivalent|the same as|no different)\b[^.]{0,120}(export|rc file|shell rc|~\/\.zsh|environment variable)/i;
    const offenders = sentencesMentioningMasterKey(text)
      .concat(text.split(/(?<=[.!?])\s+/).filter((s) => /0600|key file/i.test(s)))
      .filter((s) => equivalence.test(s))
      .filter((s) => !/\bnot\b|\*\*not\*\*/i.test(s));
    expect(offenders).toEqual([]);
    expect(text).toMatch(/is \*\*not\*\* equivalent to the 0600 key file/i);
  });

  it('names the real machine-local key path and marks the old one as legacy', () => {
    const text = doc();
    expect(text).toContain('~/.agents/.secrets-key/passphrase');

    // The pre-#479 path may be MENTIONED, but only as the legacy fallback —
    // never as a live location to look at, chmod, or write. Any sentence
    // carrying it must say so.
    const legacyPath = '~/.agents/.cache/secrets/.passphrase';
    const mentions = text
      .split(/(?<=[.!?])\s+|\n{2,}/)
      .filter((s) => s.includes(legacyPath));
    for (const s of mentions) {
      expect(s).toMatch(/legacy|pre-#479|never written|fallback|old/i);
    }
  });

  it('does not promise a TTY passphrase prompt that getPassphrase does not have', () => {
    // getPassphrase() never prompts (filestore.ts). A doc promising a prompt
    // sends operators looking for a step that does not exist, and implies the
    // store needs a passphrase at all.
    const text = doc();
    const promptClaim = /\b(prompt|asks? (you )?for|type|enter)\b[^.]{0,80}\bpassphrase\b/i;
    const offenders = text
      .split(/(?<=[.!?])\s+|\n{2,}/)
      .filter((s) => promptClaim.test(s))
      .filter((s) => !/\bnever\b|\bno\b|\bnot\b|\bwithout\b|instead/i.test(s));
    expect(offenders).toEqual([]);
    expect(text).toMatch(/\*\*never prompts\*\*/i);
  });

  it('points headless sync at the transport variable, not the master key', () => {
    const text = doc();
    expect(text).toContain('AGENTS_SYNC_PASSPHRASE');

    // Not merely "the name appears somewhere": no sentence may tell a headless
    // or CI reader to set the MASTER key to make sync work. That instruction is
    // literally what RUSH-1968 was.
    const offenders = sentencesMentioningMasterKey(text).filter(
      (s) => /\b(headless|CI|unattended|no TTY|worker box)\b/i.test(s)
        && /\b(push|pull|sync)\b/i.test(s)
        && !/\b(never|not|do not|don't|instead|deprecated|rather than)\b/i.test(s)
        // Descriptive mentions that state the variable is OPTIONAL are the
        // opposite of the failure mode; only an instruction to set it counts.
        && !/no passphrase|only if set|opt(-| )in|if it sets one/i.test(s),
    );
    expect(offenders).toEqual([]);
  });
});
