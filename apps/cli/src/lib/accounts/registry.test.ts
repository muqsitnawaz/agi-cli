import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// state.ts resolves HOME at import time, so we point HOME at a throwaway dir and
// re-import the module fresh for each test — REAL files under a temp ~/.agents,
// no mocks (mirrors device-config.test.ts).
let TMP = '';

async function fresh() {
  vi.resetModules();
  return import('./registry.js');
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-registry-'));
  process.env.HOME = TMP;
});
afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

function registryPath() {
  return path.join(TMP, '.agents', 'accounts.yaml');
}

describe('account labels central registry', () => {
  it('stores only fingerprints centrally and round-trips', async () => {
    const mod = await fresh();
    const reg = mod.readAccountLabels();
    mod.setLabelIdentity(reg, 'work', 'claude', 'a1b2c3');
    mod.setLabelIdentity(reg, 'work', 'codex', 'd4e5f6');
    mod.writeAccountLabels(reg);

    const raw = fs.readFileSync(registryPath(), 'utf-8');
    expect(raw).toContain('work');
    expect(raw).toContain('a1b2c3');
    // No secret material — this file is fleet-synced.
    expect(raw).not.toContain('@');

    const back = mod.readAccountLabels();
    expect(back.labels.work).toEqual({ claude: 'a1b2c3', codex: 'd4e5f6' });
  });

  it('refuses to assign one harness identity to two labels', async () => {
    const mod = await fresh();
    const reg = mod.readAccountLabels();
    mod.setLabelIdentity(reg, 'work', 'codex', 'same-fp');
    expect(() => mod.setLabelIdentity(reg, 'personal', 'codex', 'same-fp')).toThrow(/already labeled 'work'/);
  });

  it('allows one cross-harness label and re-attaching the same fingerprint', async () => {
    const mod = await fresh();
    const reg = mod.readAccountLabels();
    mod.setLabelIdentity(reg, 'work', 'claude', 'fp1');
    mod.setLabelIdentity(reg, 'work', 'codex', 'fp2');
    // Idempotent re-attach of the same fingerprint to the same label.
    expect(() => mod.setLabelIdentity(reg, 'work', 'claude', 'fp1')).not.toThrow();
    expect(Object.keys(reg.labels.work).sort()).toEqual(['claude', 'codex']);
  });

  it('rejects an invalid label name', async () => {
    const mod = await fresh();
    const reg = mod.readAccountLabels();
    expect(() => mod.setLabelIdentity(reg, 'Bad Name', 'claude', 'fp')).toThrow(/Invalid account label/);
  });

  it('renames and removes labels', async () => {
    const mod = await fresh();
    const reg = mod.readAccountLabels();
    mod.setLabelIdentity(reg, 'work', 'claude', 'fp1');
    mod.renameLabel(reg, 'work', 'day-job');
    expect(reg.labels['day-job']).toEqual({ claude: 'fp1' });
    expect(reg.labels.work).toBeUndefined();
    expect(mod.removeLabel(reg, 'day-job')).toBe(true);
    expect(mod.removeLabel(reg, 'day-job')).toBe(false);
  });

  it('hard-errors on a corrupt registry rather than silently starting empty', async () => {
    const mod = await fresh();
    fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), '- not\n- a map\n');
    expect(() => mod.readAccountLabels()).toThrow(/corrupted/);
  });

  it('labelForFingerprint finds the owning label', async () => {
    const mod = await fresh();
    const reg = mod.readAccountLabels();
    mod.setLabelIdentity(reg, 'work', 'claude', 'fp1');
    expect(mod.labelForFingerprint(reg, 'claude', 'fp1')).toBe('work');
    expect(mod.labelForFingerprint(reg, 'claude', 'nope')).toBeNull();
  });
});
