/**
 * Terminal-type handling for `agents ssh` interactive logins.
 *
 * The real bugs here are connectivity-shaped: an exotic local `$TERM` must be
 * recognized as "needs handling" (else the remote session breaks), a safe
 * `$TERM` must be left alone (else we pay a pointless round-trip), the
 * downgrade decision must be pure and correct, and the (host,term) cache must
 * round-trip so the propagation handshake is a once-per-host cost. `localTerminfoSource`
 * is exercised against the real local terminfo database (no mocking).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FALLBACK_TERM,
  isManagedTerm,
  localTerminfoSource,
  readTerminfoDecision,
  remoteTicCommand,
  resolveLoginTerm,
  writeTerminfoDecision,
} from './terminfo.js';

describe('isManagedTerm', () => {
  it('treats exotic terminals as managed and universal ones as pass-through', () => {
    for (const t of ['xterm-ghostty', 'xterm-kitty', 'wezterm', 'foot', 'rio']) {
      expect(isManagedTerm(t)).toBe(true);
    }
    for (const t of ['xterm', 'xterm-256color', 'screen-256color', 'tmux-256color', 'vt100', 'linux', 'dumb']) {
      expect(isManagedTerm(t)).toBe(false);
    }
  });

  it('rejects empty and injection-shaped values', () => {
    expect(isManagedTerm(undefined)).toBe(false);
    expect(isManagedTerm('')).toBe(false);
    expect(isManagedTerm('foo; rm -rf /')).toBe(false);
    expect(isManagedTerm('$(evil)')).toBe(false);
    expect(isManagedTerm('-bad')).toBe(false);
  });
});

describe('resolveLoginTerm', () => {
  it('keeps a safe term as-is regardless of propagation', () => {
    expect(resolveLoginTerm('xterm-256color', false)).toBeUndefined();
    expect(resolveLoginTerm('xterm-256color', true)).toBeUndefined();
    expect(resolveLoginTerm(undefined, false)).toBeUndefined();
  });

  it('keeps an exotic term when propagated, downgrades when not', () => {
    expect(resolveLoginTerm('xterm-ghostty', true)).toBeUndefined();
    expect(resolveLoginTerm('xterm-ghostty', false)).toBe(FALLBACK_TERM);
    expect(resolveLoginTerm('xterm-kitty', false)).toBe('xterm-256color');
  });
});

describe('remoteTicCommand', () => {
  it('installs under ~/.terminfo and self-verifies the entry', () => {
    const cmd = remoteTicCommand('xterm-ghostty');
    expect(cmd).toContain('tic -x -o "$HOME/.terminfo" -');
    expect(cmd).toContain('infocmp -x xterm-ghostty');
  });
});

describe('localTerminfoSource', () => {
  it('produces source for a universally-present term and null for a bogus one', () => {
    // xterm-256color ships in every terminfo database, so infocmp must resolve it.
    const src = localTerminfoSource('xterm-256color');
    expect(src).not.toBeNull();
    expect(src).toMatch(/xterm-256color/);
    // A name that cannot exist in any database resolves to null (no throw).
    expect(localTerminfoSource('definitely-not-a-real-terminal-xyz')).toBeNull();
  });

  it('refuses an invalid terminfo name without shelling out', () => {
    expect(localTerminfoSource('foo; echo pwned')).toBeNull();
  });
});

describe('terminfo decision cache', () => {
  it('round-trips a decision and returns null for an unknown pair', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminfo-cache-'));
    try {
      expect(readTerminfoDecision('host-a', 'xterm-ghostty', dir)).toBeNull();
      writeTerminfoDecision('host-a', 'xterm-ghostty', 'ok', dir);
      expect(readTerminfoDecision('host-a', 'xterm-ghostty', dir)).toBe('ok');
      writeTerminfoDecision('host-b', 'xterm-kitty', 'downgrade', dir);
      expect(readTerminfoDecision('host-b', 'xterm-kitty', dir)).toBe('downgrade');
      // Distinct pairs don't collide.
      expect(readTerminfoDecision('host-a', 'xterm-ghostty', dir)).toBe('ok');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
