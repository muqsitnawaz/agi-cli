import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerWalletCommands } from './wallet.js';

describe('removed wallet command', () => {
  for (const args of [[], ['add'], ['list'], ['ls'], ['show', 'card'], ['rename', 'card', 'new'], ['remove', 'card'], ['rm', 'card']]) {
    it(`redirects wallet ${args.join(' ')}`.trim(), async () => {
      const program = new Command().exitOverride();
      registerWalletCommands(program);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
      await expect(program.parseAsync(['node', 'agents', 'wallet', ...args])).rejects.toThrow('exit:2');
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('agents secrets'));
      exit.mockRestore(); stderr.mockRestore();
    });
  }
});
