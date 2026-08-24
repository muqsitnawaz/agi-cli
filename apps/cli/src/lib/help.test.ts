import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { applyGlobalHelpConventions, bareGroupHint, installBareGroupGuards, registerCommandGroups, setHelpSections } from './help.js';

function buildTestCommand(opts: { examples?: string; notes?: string } = {}): Command {
  const root = new Command('agents');
  const sub = root
    .command('demo')
    .description('Run a demo of the help formatter.')
    .option('--flag', 'a flag');

  applyGlobalHelpConventions(root);
  setHelpSections(sub, opts);
  return sub;
}

describe('setHelpSections + formatHelpCommandsFirst', () => {
  it('renders Examples between the description and Options', () => {
    const sub = buildTestCommand({
      examples: `
        # do the thing
        agents demo
      `,
    });
    const help = sub.helpInformation();

    const descIdx = help.indexOf('Run a demo of the help formatter.');
    const examplesIdx = help.indexOf('Examples:');
    const optionsIdx = help.indexOf('Options:');

    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(examplesIdx).toBeGreaterThan(descIdx);
    expect(optionsIdx).toBeGreaterThan(examplesIdx);
  });

  it('renders Notes after Options at the very end', () => {
    const sub = buildTestCommand({
      examples: '# x\nagents demo',
      notes: '- a caveat',
    });
    const help = sub.helpInformation();

    const optionsIdx = help.indexOf('Options:');
    const notesIdx = help.indexOf('Notes:');

    expect(optionsIdx).toBeGreaterThanOrEqual(0);
    expect(notesIdx).toBeGreaterThan(optionsIdx);
    expect(help.slice(notesIdx)).toContain('- a caveat');
  });

  it('omits Examples and Notes headings when no sections are set', () => {
    const sub = buildTestCommand();
    const help = sub.helpInformation();

    expect(help).not.toContain('Examples:');
    expect(help).not.toContain('Notes:');
  });

  it('dedents bodies so callers can pass natural indented template literals', () => {
    const sub = buildTestCommand({
      examples: `
            # comment
            agents demo --flag
      `,
    });
    const help = sub.helpInformation();

    // After dedent + 2-space reindent, both comment and command sit at column 2.
    expect(help).toContain('\n  # comment\n');
    expect(help).toContain('\n  agents demo --flag\n');
  });

  it('preserves internal indentation inside dedented blocks', () => {
    const sub = buildTestCommand({
      notes: `
        Modes:
          plan  read-only
          edit  can write
      `,
    });
    const help = sub.helpInformation();
    expect(help).toContain('  Modes:');
    expect(help).toContain('    plan  read-only');
    expect(help).toContain('    edit  can write');
  });
});

describe('registerCommandGroups', () => {
  function buildGroupedParent(): Command {
    const root = new Command('agents');
    const parent = root.command('devices').description('Device registry.');
    for (const name of ['sync', 'list', 'show', 'status', 'prefer']) {
      parent.command(name).description(`${name} devices.`);
    }
    applyGlobalHelpConventions(root);
    registerCommandGroups(parent, [
      { title: 'Discover & register', names: ['sync'] },
      { title: 'Inspect', names: ['list', 'show', 'status'] },
    ]);
    return parent;
  }

  it('renders groups as titled sections in the registered order', () => {
    const help = buildGroupedParent().helpInformation();

    const discoverIdx = help.indexOf('Discover & register:');
    const inspectIdx = help.indexOf('Inspect:');

    expect(discoverIdx).toBeGreaterThanOrEqual(0);
    expect(inspectIdx).toBeGreaterThan(discoverIdx);
    expect(help.slice(discoverIdx, inspectIdx)).toContain('sync');
    expect(help.slice(inspectIdx)).toContain('list');
    expect(help.slice(inspectIdx)).toContain('show');
    expect(help.slice(inspectIdx)).toContain('status');
  });

  it('renders ungrouped subcommands under a plain Commands section after the groups', () => {
    const help = buildGroupedParent().helpInformation();

    const inspectIdx = help.indexOf('Inspect:');
    const commandsIdx = help.indexOf('Commands:');

    expect(commandsIdx).toBeGreaterThan(inspectIdx);
    expect(help.slice(commandsIdx)).toContain('prefer');
    expect(help.slice(commandsIdx)).not.toContain('sync');
  });

  it('skips a group whose names match no visible subcommand', () => {
    const root = new Command('agents');
    const parent = root.command('devices').description('Device registry.');
    parent.command('list').description('List devices.');
    applyGlobalHelpConventions(root);
    registerCommandGroups(parent, [
      { title: 'Ghost group', names: ['nope'] },
      { title: 'Inspect', names: ['list'] },
    ]);
    const help = parent.helpInformation();

    expect(help).not.toContain('Ghost group:');
    expect(help).toContain('Inspect:');
    expect(help).not.toContain('Commands:');
  });
});

describe('installBareGroupGuards (RUSH-3104)', () => {
  // A hook that runs `agents <group>` as a subprocess captures its output; the
  // pre-fix default dumped commander's full ~60-line help to stderr, which then
  // leaked verbatim into injected hook feedback. A bare group in a captured
  // (non-TTY) stream must now emit exactly one usage line.
  function buildGuarded(): { root: Command; browser: Command; errBuf: string[] } {
    const root = new Command('agents');
    const browser = root.command('browser').description('Drive browsers.');
    browser.command('start').description('Start a task.').action(() => {});
    browser.command('status').description('Show tasks.').action(() => {});
    applyGlobalHelpConventions(root);
    const errBuf: string[] = [];
    root.exitOverride();
    browser.exitOverride();
    browser.configureOutput({ writeErr: (s) => errBuf.push(s), writeOut: (s) => errBuf.push(s) });
    return { root, browser, errBuf };
  }

  it('a bare group emits ONE usage line, not the multi-section help dump', () => {
    const { root, errBuf } = buildGuarded();
    // vitest's process.stderr.isTTY is falsy, so the captured-stream branch runs.
    expect(() => root.parse(['browser'], { from: 'user' })).toThrow();
    const out = errBuf.join('');
    expect(out).toBe('agents browser: missing subcommand. Run `agents browser --help` for the options.\n');
    // The tell of the leak: none of the help sections may appear.
    expect(out).not.toContain('Usage: agents browser');
    expect(out).not.toContain('Commands:');
    expect(out).not.toContain('Options:');
  });

  it('does not steal a valid subcommand — dispatch still works', () => {
    const { root, browser } = buildGuarded();
    let started = false;
    browser.commands.find((c) => c.name() === 'start')!.action(() => { started = true; });
    root.parse(['browser', 'start'], { from: 'user' });
    expect(started).toBe(true);
  });

  it('leaves a group that declares its own default action untouched', () => {
    const root = new Command('agents');
    let ran = false;
    const grp = root.command('sessions').description('Sessions.').action(() => { ran = true; });
    grp.command('list').description('List.').action(() => {});
    installBareGroupGuards(root);
    root.parse(['sessions'], { from: 'user' });
    // The group's own action fired — the guard did not replace it.
    expect(ran).toBe(true);
  });

  it('bareGroupHint names the full command path for a nested group', () => {
    const root = new Command('agents');
    const browser = root.command('browser');
    const profiles = browser.command('profiles');
    profiles.command('list').action(() => {});
    expect(bareGroupHint(profiles)).toBe(
      'agents browser profiles: missing subcommand. Run `agents browser profiles --help` for the options.',
    );
  });
});
