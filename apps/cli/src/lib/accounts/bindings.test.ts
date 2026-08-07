import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let TMP = '';

async function fresh() {
  vi.resetModules();
  return import('./bindings.js');
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-bindings-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});
afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('per-device account bindings', () => {
  it('writes to devices/<host>/accounts.yaml, not agents.yaml', async () => {
    const mod = await fresh();
    const b = mod.readAccountBindings();
    mod.setBinding(b, 'work', 'claude', ['2.1.220', '2.1.219']);
    mod.writeAccountBindings(b);
    const file = path.join(TMP, '.agents', 'devices', 'testbox', 'accounts.yaml');
    expect(fs.existsSync(file)).toBe(true);
    // The device's agents.yaml is untouched — older CLIs cannot erase bindings.
    expect(fs.existsSync(path.join(TMP, '.agents', 'devices', 'testbox', 'agents.yaml'))).toBe(false);
    expect(mod.readAccountBindings().bindings.work).toEqual({ claude: ['2.1.219', '2.1.220'] });
  });

  it('collapses a version list containing the marker to version-global', async () => {
    const mod = await fresh();
    const b = mod.readAccountBindings();
    mod.setBinding(b, 'work', 'codex', ['0.1.0', '*']);
    expect(b.bindings.work.codex).toEqual(['*']);
  });

  it("expands '*' to every installed version and intersects a list with installs", async () => {
    const mod = await fresh();
    const b = mod.readAccountBindings();
    mod.setBinding(b, 'work', 'claude', ['*']);
    expect(mod.resolveBoundVersions(b, 'work', 'claude', ['2.1.1', '2.1.2'])).toEqual(['2.1.1', '2.1.2']);
    mod.setBinding(b, 'work', 'claude', ['2.1.1', '2.1.9']);
    // 2.1.9 is bound but not installed -> dropped.
    expect(mod.resolveBoundVersions(b, 'work', 'claude', ['2.1.1', '2.1.2'])).toEqual(['2.1.1']);
  });

  it('labelForVersion matches a concrete version and a global marker', async () => {
    const mod = await fresh();
    const b = mod.readAccountBindings();
    mod.setBinding(b, 'work', 'claude', ['2.1.1']);
    mod.setBinding(b, 'work', 'codex', ['*']);
    expect(mod.labelForVersion(b, 'claude', '2.1.1')).toBe('work');
    expect(mod.labelForVersion(b, 'claude', '2.1.2')).toBeNull();
    expect(mod.labelForVersion(b, 'codex', 'anything')).toBe('work');
  });

  it('removes a harness binding, then the whole label when empty', async () => {
    const mod = await fresh();
    const b = mod.readAccountBindings();
    mod.setBinding(b, 'work', 'claude', ['2.1.1']);
    mod.setBinding(b, 'work', 'codex', ['*']);
    expect(mod.removeBinding(b, 'work', 'claude')).toBe(true);
    expect(b.bindings.work).toEqual({ codex: ['*'] });
    expect(mod.removeBinding(b, 'work')).toBe(true);
    expect(b.bindings.work).toBeUndefined();
  });

  it('hard-errors on a corrupt bindings file', async () => {
    const mod = await fresh();
    const file = path.join(TMP, '.agents', 'devices', 'testbox', 'accounts.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'just a string');
    expect(() => mod.readAccountBindings()).toThrow(/corrupted/);
  });
});
