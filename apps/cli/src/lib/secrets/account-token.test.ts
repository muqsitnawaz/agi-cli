import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountTokenKey, resolveAccountSetupToken, readAccountSetupToken, CLAUDE_SETUP_TOKEN_BUNDLE } from './account-token.js';
import { writeBundle, deleteBundle } from './bundles.js';
import { _resetFileStoreForTest } from './filestore.js';
import { setKeychainBackendForTest } from './index.js';

const tmpHomes: string[] = [];
function homeWith(email: string, atHomeLevel = false): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-token-'));
  tmpHomes.push(home);
  const file = atHomeLevel
    ? path.join(home, '.claude.json')
    : path.join(home, '.claude', '.claude.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return home;
}
afterEach(() => {
  while (tmpHomes.length) fs.rmSync(tmpHomes.pop()!, { recursive: true, force: true });
});

describe('accountTokenKey', () => {
  it('encodes an email the way the live per-account bundle keys are named', () => {
    // Verified against real bundle keys.
    expect(accountTokenKey('muqsit@getrush.ai')).toBe('CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_GETRUSH_DOT_AI');
    expect(accountTokenKey('muqsitnawaz@gmail.com')).toBe('CLAUDE_CODE_OAUTH_TOKEN_MUQSITNAWAZ_AT_GMAIL_DOT_COM');
    expect(accountTokenKey('muqsit@trp.so')).toBe('CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_TRP_DOT_SO');
    expect(accountTokenKey('muqsitnawaz@icloud.com')).toBe('CLAUDE_CODE_OAUTH_TOKEN_MUQSITNAWAZ_AT_ICLOUD_DOT_COM');
  });

  it('collapses other non-alphanumerics (hyphens, plus) to underscore', () => {
    expect(accountTokenKey('a.b-c+d@x.co')).toBe('CLAUDE_CODE_OAUTH_TOKEN_A_DOT_B_C_D_AT_X_DOT_CO');
  });
});

describe('resolveAccountSetupToken', () => {
  it('reads the home account email and returns its matching per-account token (the real path)', () => {
    const home = homeWith('muqsit@getrush.ai');
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_GETRUSH_DOT_AI: 'sk-ant-oat-getrush',
      CLAUDE_CODE_OAUTH_TOKEN_MUQSITNAWAZ_AT_GMAIL_DOT_COM: 'sk-ant-oat-gmail',
    };
    expect(resolveAccountSetupToken(env, home)).toBe('sk-ant-oat-getrush');
  });

  it('falls back to the home-level .claude.json (IDE / direct-binary sign-in)', () => {
    const home = homeWith('muqsitnawaz@gmail.com', /* atHomeLevel */ true);
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_MUQSITNAWAZ_AT_GMAIL_DOT_COM: 'sk-ant-oat-gmail' }, home))
      .toBe('sk-ant-oat-gmail');
  });

  it('returns null when the home account has no matching token in env (safe no-op)', () => {
    const home = homeWith('nobody@nowhere.co');
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_X: 'y' }, home)).toBeNull();
  });

  it('returns null when the home has no account file at all', () => {
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_X: 'y' }, '/nonexistent/home')).toBeNull();
  });

  it('ignores an empty/whitespace token value', () => {
    const home = homeWith('muqsit@getrush.ai');
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_GETRUSH_DOT_AI: '   ' }, home)).toBeNull();
  });
});

describe('readAccountSetupToken (reads the file-backed auth bundle — no keychain)', () => {
  const PASS = 'acct-token-test-pass';
  let storeDir: string;
  let prevPass: string | undefined;
  let prevNoAgent: string | undefined;

  beforeEach(() => {
    // Hermetic file store + no keychain/agent, so the read resolves entirely from
    // the encrypted file — exactly the headless, Touch-ID-free path in production.
    setKeychainBackendForTest(null);
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-token-store-'));
    prevPass = process.env.AGENTS_SECRETS_PASSPHRASE;
    prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    _resetFileStoreForTest({ fileDir: storeDir, passphrase: PASS });
  });

  afterEach(() => {
    try { deleteBundle(CLAUDE_SETUP_TOKEN_BUNDLE); } catch { /* not created */ }
    _resetFileStoreForTest({});
    if (prevPass === undefined) delete process.env.AGENTS_SECRETS_PASSPHRASE;
    else process.env.AGENTS_SECRETS_PASSPHRASE = prevPass;
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('returns the per-account setup-token for the home account, read from the file bundle', () => {
    const home = homeWith('muqsit@trp.so');
    writeBundle({
      name: CLAUDE_SETUP_TOKEN_BUNDLE,
      backend: 'file',
      vars: { CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_TRP_DOT_SO: 'sk-ant-oat01-trp' },
    });
    expect(readAccountSetupToken(home)).toBe('sk-ant-oat01-trp');
  });

  it('returns null (never the interactive login) when no token is seeded for the account', () => {
    const home = homeWith('muqsit@trp.so');
    writeBundle({
      name: CLAUDE_SETUP_TOKEN_BUNDLE,
      backend: 'file',
      vars: { CLAUDE_CODE_OAUTH_TOKEN_SOMEONE_ELSE_AT_X_DOT_CO: 'sk-ant-oat01-other' },
    });
    expect(readAccountSetupToken(home)).toBeNull();
  });

  it('returns null when the home has no signed-in account', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-token-noacct-'));
    expect(readAccountSetupToken(home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
