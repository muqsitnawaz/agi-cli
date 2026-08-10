import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerTicketsCommand } from './tickets.js';

describe('tickets list', () => {
  it('emits the canonical aggregate shape', async () => {
    const program = new Command().exitOverride();
    registerTicketsCommand(program);
    const lines: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => lines.push(String(value ?? ''));
    try { await program.parseAsync(['node', 'agents', 'tickets', 'list', '--no-linear', '--no-github', '--json']); }
    finally { console.log = original; }
    expect(JSON.parse(lines[0])).toEqual({ tickets: [], cycleInfo: null, sources: { linear: false, github: false } });
  });
});
