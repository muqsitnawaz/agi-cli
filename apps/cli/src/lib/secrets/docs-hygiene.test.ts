/**
 * Guard: `docs/secrets.md` must not teach the leak it documents a finding for.
 *
 * RUSH-1968 happened partly because the docs *recommended* the thing `agents
 * doctor` flags — the file-store section called an rc export "Recommended for
 * shared/CI machines" and called a 0600 key file "identical to" it. An operator
 * who followed the docs put a master key into `~/.zshenv` on seven boxes.
 *
 * ## How this guard decides, and why it is not a phrase blocklist
 *
 * Two earlier drafts tried to classify English: first by matching the exact
 * sentences that shipped the bad advice (trivially defeated by rewording), then
 * by matching danger patterns while excluding sentences containing a negation
 * word (trivially defeated by ADDING a word — `Export … in ~/.zshenv; it is not
 * necessary to configure anything else.` passed because it contained "not").
 * Both failed the same way: no regex reliably tells "warning about X" from
 * "instructing X".
 *
 * So the doc marks its own exceptions instead. The two passages that legitimately
 * discuss the master-key export — the warning that forbids it, and the bounded
 * per-command `export … ; unset` release example — are wrapped in
 * `<!-- docs-hygiene:allow-master-key-discussion -->` / `<!-- /… -->`. This test
 * strips those regions and forbids the danger patterns everywhere else, with no
 * escape hatch. Adding a new rc-file mention therefore fails until the author
 * consciously marks it as intentional, which is exactly the review moment that
 * was missing when the original advice was written.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SECRETS_DOC = path.join(CLI_ROOT, 'docs', 'secrets.md');

const ALLOW_OPEN = '<!-- docs-hygiene:allow-master-key-discussion';
const ALLOW_CLOSE = '<!-- /docs-hygiene:allow-master-key-discussion -->';

function doc(): string {
  return fs.readFileSync(SECRETS_DOC, 'utf-8');
}

/**
 * The doc with every explicitly-marked exception region removed. Everything
 * returned here is held to the rules below unconditionally.
 */
function guarded(): string {
  const text = doc();
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf(ALLOW_OPEN, i);
    if (open === -1) { out += text.slice(i); break; }
    out += text.slice(i, open);
    const close = text.indexOf(ALLOW_CLOSE, open);
    // An unterminated marker would silently swallow the rest of the file.
    expect(close, `unterminated ${ALLOW_OPEN} region at offset ${open}`).not.toBe(-1);
    i = close + ALLOW_CLOSE.length;
  }
  return out;
}

const RC_FILE = String.raw`~/\.(zshenv|zshrc|bashrc|bash_profile|profile)\b|\bshell rc\b|\blogin profile\b|\bshell profile\b|\brc file\b|\.zshenv\b`;

/**
 * The section documenting the file store's own key resolution, guarded-text
 * only. Some claims (notably "no TTY prompt") are true of the FILE STORE and
 * false of `push`/`pull`, which prompt for the transport passphrase — so those
 * checks must not be applied document-wide.
 */
const FILE_STORE_HEADING = '## Linux: headless servers and the encrypted-file fallback';

function fileStoreSection(): string {
  const text = guarded();
  const start = text.indexOf(FILE_STORE_HEADING);
  if (start === -1) return '';
  const next = text.indexOf('\n## ', start + FILE_STORE_HEADING.length);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

describe('docs/secrets.md hygiene (RUSH-1968)', () => {
  it('marks its exception regions in matched pairs', () => {
    // guarded() asserts termination; this pins the count so a stray opener or a
    // deleted closer is a loud failure rather than a silently widened exception.
    const text = doc();
    const opens = text.split(ALLOW_OPEN).length - 1;
    const closes = text.split(ALLOW_CLOSE).length - 1;
    expect(opens).toBe(closes);
    expect(opens).toBe(2);
  });

  it('never mentions a shell rc file outside a marked region', () => {
    // In this document an rc file has exactly two legitimate reasons to appear:
    // the warning that forbids the export, and the bounded per-command example.
    // Both are marked. Anywhere else it is advice to persist a credential in a
    // file every child process inherits — no phrasing of that is acceptable, so
    // this needs no verb heuristic and has no negation escape hatch.
    const offenders = guarded()
      .split('\n')
      .filter((line) => new RegExp(RC_FILE, 'i').test(line));
    expect(offenders).toEqual([]);
  });

  it('never recommends the master passphrase for shared or CI machines', () => {
    expect(guarded()).not.toMatch(/Recommended for shared\/CI machines/i);
  });

  it('never equates the 0600 key file with an environment or rc export', () => {
    // The inverted claim is what made the export look sanctioned. Checked over
    // the guarded text, so the warning's own "is **not** equivalent" sentence
    // (inside a marked region) cannot be mistaken for the claim it refutes —
    // and no sentence can buy immunity by containing the word "not".
    const equivalence = new RegExp(
      String.raw`\b(identical|equivalent|the same as|no different|no safer|as safe as)\b[^.]{0,140}` +
      String.raw`(export|rc file|shell rc|~/\.zsh|environment variable|env var)`,
      'i',
    );
    const offenders = guarded()
      .split(/(?<=[.!?])\s+|\n{2,}/)
      .filter((s) => equivalence.test(s));
    expect(offenders).toEqual([]);
  });

  it('names the real machine-local key path and never writes to the legacy one', () => {
    const text = doc();
    expect(text).toContain('~/.agents/.secrets-key/passphrase');

    const legacyPath = '~/.agents/.cache/secrets/.passphrase';
    const mentions = text
      .split(/(?<=[.!?])\s+|\n{2,}/)
      .filter((s) => s.includes(legacyPath));

    // The legacy path may be described as a read-only fallback. It may never be
    // presented as somewhere a key is written or should be placed — a sentence
    // merely containing the word "old" does not earn that.
    for (const s of mentions) {
      expect(s, `legacy path mentioned without marking it read-only: ${s}`)
        .toMatch(/read as a fallback|never written|legacy|pre-#479/i);
      expect(s, `legacy path presented as a write target: ${s}`)
        .not.toMatch(/\b(written to|write|writes|save|store|place|put|generated (in|at))\b(?![^.]*never written)/i);
    }
  });

  it('does not promise a passphrase prompt that getPassphrase does not have', () => {
    // Scoped to the file-store section on purpose. `agents secrets push`/`pull`
    // genuinely DO prompt — for the TRANSPORT passphrase, a different secret
    // (see AGENTS_SYNC_PASSPHRASE / RUSH-1968). The false claim was specifically
    // that the file store's own key resolution has a TTY step; `getPassphrase()`
    // never prompts.
    const section = fileStoreSection();
    expect(section, 'file-store section heading not found — update the anchor')
      .not.toBe('');

    const promptClaim = new RegExp(
      String.raw`\b(prompts?|asks?|asked|requests?|requested|prompted)\b[^.]{0,90}\bpassphrase\b` +
      String.raw`|\bpassphrase\b[^.]{0,60}\b(prompt|is requested|is asked)\b`,
      'i',
    );
    const offenders = section
      .split(/(?<=[.!?])\s+|\n{2,}/)
      .filter((s) => promptClaim.test(s))
      // The section must be able to state that it does NOT prompt.
      .filter((s) => !/\bnever prompts\b|\bno prompt\b|\bdoes not prompt\b|without being prompted/i.test(s));
    expect(offenders).toEqual([]);
    expect(doc()).toMatch(/\*\*never prompts\*\*/i);
  });

  it('points headless sync at the transport variable, not the master key', () => {
    const text = doc();
    expect(text).toContain('AGENTS_SYNC_PASSPHRASE');

    // No passage outside a marked region may tell a headless/CI reader to set
    // the MASTER key so that push/pull works. That instruction is RUSH-1968.
    const offenders = guarded()
      .split(/(?<=[.!?])\s+|\n{2,}/)
      .filter((s) => s.includes('AGENTS_SECRETS_PASSPHRASE'))
      .filter((s) => /\b(headless|CI|unattended|no TTY|worker box)\b/i.test(s))
      .filter((s) => /\b(push|pull|sync)\b/i.test(s))
      // Descriptive mentions stating the variable is OPTIONAL are the opposite
      // of the failure mode; only an instruction to set it counts.
      .filter((s) => !/no passphrase|only if set|opt(-| )in|if it sets one/i.test(s));
    expect(offenders).toEqual([]);
  });
});
