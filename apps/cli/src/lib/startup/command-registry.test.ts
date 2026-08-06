/**
 * RUSH-2022 — `KNOWN_TOP_LEVEL_COMMANDS` is the "does this command exist?"
 * predicate the `--host`/`--device` router consults before it can claim a
 * command has no remote semantics. A name that drifts out of it turns a real
 * command into a phantom `unknown command`, so this pins the set against the
 * command tree the CLI actually registers — the real modules, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  COMMAND_LOADERS,
  LAZY_COMMAND_NAMES,
  KNOWN_TOP_LEVEL_COMMANDS,
  isKnownTopLevelCommand,
  suggestTopLevelCommand,
} from './command-registry.js';

/** Register every module in the loader table onto one fresh program. */
async function registerEverything(): Promise<Command> {
  const program = new Command();
  const done = new Set<unknown>();
  for (const loaders of Object.values(COMMAND_LOADERS)) {
    for (const loader of loaders) {
      if (done.has(loader)) continue;
      done.add(loader);
      (await loader())(program);
    }
  }
  return program;
}

describe('KNOWN_TOP_LEVEL_COMMANDS', () => {
  it('covers every top-level name and alias the real command modules register', async () => {
    const program = await registerEverything();
    const registered = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(registered.length).toBeGreaterThan(50); // the tree really did load
    const missing = registered.filter((name) => !KNOWN_TOP_LEVEL_COMMANDS.has(name));
    expect(missing).toEqual([]);
  });

  it('includes the lazily-registered groups (sessions/teams/cloud/…)', () => {
    for (const name of LAZY_COMMAND_NAMES) {
      expect(isKnownTopLevelCommand(name)).toBe(true);
    }
  });

  it('includes the aliases and tombstones src/index.ts registers inline', () => {
    // Not in COMMAND_LOADERS — they are closures over entry-point state — but
    // they are real commands, so the router must not treat them as unknown.
    for (const name of ['perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', 'upgrade', '_internal']) {
      expect(isKnownTopLevelCommand(name)).toBe(true);
    }
  });

  it('suggests the lazily-registered group a typo meant — the RUSH-2022 miss', () => {
    // The old spellcheck ranked against the commands registered SO FAR, and
    // `sessions` is lazy, so this typo got no suggestion at all.
    expect(suggestTopLevelCommand('session')).toEqual({ name: 'sessions', distance: 1 });
    expect(suggestTopLevelCommand('sesions')).toEqual({ name: 'sessions', distance: 1 });
    expect(suggestTopLevelCommand('docto')).toEqual({ name: 'doctor', distance: 1 });
  });

  it('never suggests an internal command', () => {
    expect(suggestTopLevelCommand('_internal')?.name).not.toBe('_internal');
  });

  it('rejects a name the CLI does not register', () => {
    expect(isKnownTopLevelCommand('session')).toBe(false); // the RUSH-2022 typo
    expect(isKnownTopLevelCommand('zzzznotacommand')).toBe(false);
    expect(isKnownTopLevelCommand('')).toBe(false);
  });
});
