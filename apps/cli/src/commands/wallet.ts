/** Removed `agents wallet`; retained as a hard-error redirect. */
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';

const REDIRECT = 'agents-cli: "agents wallet" was removed.\n            Store credentials: agents secrets create <bundle>\n            Remove old cards:  delete Keychain items named agents-cli.secrets.wallet.<id>\n\n';
function removed(): never { process.stderr.write(REDIRECT); process.exit(2); }

export function registerWalletCommands(program: Command): void {
  const cmd = program.command('wallet').description('Removed. Use `agents secrets`.');
  setHelpSections(cmd, { notes: '\n      Removed. Store credentials with `agents secrets`.\n' });
  cmd.action(removed);
  cmd.command('add').allowUnknownOption().allowExcessArguments().action(removed);
  cmd.command('list').alias('ls').allowUnknownOption().allowExcessArguments().action(removed);
  cmd.command('show [id]').allowUnknownOption().allowExcessArguments().action(removed);
  cmd.command('rename [id] [new-nickname]').allowUnknownOption().allowExcessArguments().action(removed);
  cmd.command('remove [id]').alias('rm').allowUnknownOption().allowExcessArguments().action(removed);
}
