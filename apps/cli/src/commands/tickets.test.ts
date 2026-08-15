import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerTicketsCommand } from './tickets.js';

describe('registerTicketsCommand', () => {
  it('registers the canonical list JSON path with source controls', () => {
    const program = new Command();
    registerTicketsCommand(program);

    const tickets = program.commands.find(command => command.name() === 'tickets');
    const list = tickets?.commands.find(command => command.name() === 'list');

    expect(list).toBeDefined();
    expect(list?.options.map(option => option.long)).toEqual([
      '--cwd',
      '--no-linear',
      '--no-github',
      '--github-assigned-only',
      '--json',
    ]);
  });
});
