import type { Command } from 'commander';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { resolveAgentName, formatAgentError } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { listInstalledVersions } from '../lib/versions.js';
import { discoverAccounts, nameAccount, removeAccountLabel, renameAccountLabel } from '../lib/account-labels.js';
import { addApiKeyAccount, findByLabel, readRegistry, setAccountKey } from '../lib/account-registry.js';
import { getKeychainToken, secretsKeychainItem } from '../lib/secrets/index.js';
import { listApiKeyProviders } from '../lib/account-provider-registry.js';
import { setHelpSections } from '../lib/help.js';

function parseSource(raw: string): { agent: AgentId; version: string } { const at = raw.lastIndexOf('@'); if (at < 1 || at === raw.length - 1) throw new Error(`Expected <agent>@<version>, got '${raw}'.`); const name = raw.slice(0, at); const agent = resolveAgentName(name); if (!agent) throw new Error(formatAgentError(name)); return { agent, version: raw.slice(at + 1) }; }
export async function fingerprintFromSource(
  raw: string,
  deps: { installedVersions?: typeof listInstalledVersions; discover?: typeof discoverAccounts } = {},
): Promise<{ agent: AgentId; fingerprint: string; versions: string[] }> {
  const { agent, version } = parseSource(raw);
  if (!(deps.installedVersions ?? listInstalledVersions)(agent).includes(version)) throw new Error(`${raw} is not installed.`);
  const account = (await (deps.discover ?? discoverAccounts)([agent])).find(candidate => candidate.versions.includes(version));
  if (!account) throw new Error(`${raw} has no stable signed-in account. Run it and complete its normal login first.`);
  return { agent, fingerprint: account.fingerprint, versions: account.versions };
}

/**
 * Parse a `bundle:key` flag value into its components. Exported for tests.
 * Does NOT read from the keychain — call {@link readFromSecretsFlag} for that.
 */
export function parseBundleKey(raw: string): { bundle: string; key: string } {
  const colon = raw.indexOf(':');
  if (colon < 1 || colon === raw.length - 1) throw new Error(`Expected bundle:key, got '${raw}'.`);
  return { bundle: raw.slice(0, colon), key: raw.slice(colon + 1) };
}

function readFromSecretsFlag(raw: string): string {
  const { bundle, key } = parseBundleKey(raw);
  return getKeychainToken(secretsKeychainItem(bundle, key));
}

async function printAccounts(json: boolean): Promise<void> { const accounts = await discoverAccounts(); if (json) return console.log(JSON.stringify(accounts, null, 2)); if (!accounts.length) return console.log(chalk.gray('No signed-in accounts found. Run an installed agent and complete its normal login first.')); console.log(chalk.bold('Signed-in accounts\n')); for (const account of accounts) console.log(`  ${account.label ? chalk.cyan(account.label) : chalk.gray('(unnamed)')}  ${account.agent}  ${account.display}\n    ${account.versions.length} installed version${account.versions.length === 1 ? '' : 's'}: ${account.versions.join(', ')}`); }
async function chooseAccount() { const accounts = await discoverAccounts(); if (!accounts.length) throw new Error('No signed-in accounts found. Run an installed agent and complete its normal login first.'); return select({ message: 'Which signed-in account do you want to name?', choices: accounts.map(account => ({ name: `${account.agent}  ${account.display}  (${account.versions.length} version${account.versions.length === 1 ? '' : 's'})${account.label ? `  currently "${account.label}"` : ''}`, value: account })) }); }

export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Browse and name signed-in harness accounts').option('--json', 'Machine-readable discovered accounts').action(async (o: {json?: boolean}) => printAccounts(!!o.json));
  accounts.command('list').description('Alias for accounts').option('--json', 'Machine-readable discovered accounts').action((o: {json?: boolean}) => printAccounts(!!o.json));
  accounts.command('name <label>').description('Name one signed-in account; matching installed versions are found automatically').option('--from <agent@version>', 'Non-interactive identity source').action(async (label: string, o: {from?: string}) => { const picked = o.from ? await fingerprintFromSource(o.from) : await chooseAccount(); nameAccount(label, picked.agent, picked.fingerprint); console.log(chalk.green(`Named the ${picked.agent} account '${label}'.`)); console.log(chalk.gray(`Found it in ${picked.versions.length} installed version${picked.versions.length === 1 ? '' : 's'}: ${picked.versions.join(', ')}`)); });
  accounts.command('rename <old> <new>').description('Rename a saved account label').action((oldLabel: string, newLabel: string) => renameAccountLabel(oldLabel, newLabel));
  accounts.command('remove <label>').description('Remove a saved account label').action((label: string) => removeAccountLabel(label));

  accounts.command('add <name>')
    .description('Add an API-key account')
    .requiredOption('--provider <name>', `Agent that uses an API key (${listApiKeyProviders().join(', ')})`)
    .requiredOption('--auth <type>', 'Authentication type: api-key')
    .option('--from-secrets <bundle:key>', 'Read the API key from an existing agents secrets bundle entry')
    .action(async (name: string, o: { provider: string; auth: string; fromSecrets?: string }) => {
      if (o.auth !== 'api-key') throw new Error(`Unsupported auth type '${o.auth}'. Only 'api-key' is supported.`);
      const agent = resolveAgentName(o.provider);
      if (!agent) throw new Error(formatAgentError(o.provider));
      if (!listApiKeyProviders().includes(agent)) throw new Error(`Provider '${agent}' does not support api-key auth. Supported: ${listApiKeyProviders().join(', ')}.`);
      let key: string;
      if (o.fromSecrets) {
        key = readFromSecretsFlag(o.fromSecrets);
      } else {
        const { password } = await import('@inquirer/prompts');
        key = await password({ message: `Enter ${agent} API key for '${name}':` });
      }
      addApiKeyAccount(name, agent, key);
      console.log(chalk.green(`Added ${agent} api-key account '${name}'.`));
      console.log(chalk.gray('Key stored in the device keychain — never written to YAML.'));
    });

  accounts.command('set-key <name>')
    .description('Update the API key for an api-key account')
    .option('--from-secrets <bundle:key>', 'Read the new key from an existing agents secrets bundle entry')
    .action(async (name: string, o: { fromSecrets?: string }) => {
      let key: string;
      if (o.fromSecrets) {
        key = readFromSecretsFlag(o.fromSecrets);
      } else {
        const { password } = await import('@inquirer/prompts');
        key = await password({ message: `Enter new API key for '${name}':` });
      }
      setAccountKey(name, key);
      console.log(chalk.green(`Updated API key for account '${name}'.`));
    });

  accounts.command('inspect <name>')
    .description('Show the stored record for a named account (no secrets)')
    .option('--json', 'Machine-readable output')
    .action((name: string, o: { json?: boolean }) => {
      const doc = readRegistry();
      const record = findByLabel(name, doc);
      if (!record) throw new Error(`Unknown account label '${name}'.`);
      if (o.json) {
        const out: Record<string, unknown> = {
          id: record.id,
          label: record.label,
          agent: record.agent,
          credentialKind: record.credential.kind,
        };
        if (record.credential.kind === 'api-key') out.secretRef = record.credential.secretRef.value;
        else out.fingerprint = record.credential.fingerprint;
        console.log(JSON.stringify(out, null, 2));
        return;
      }
      console.log(`${chalk.bold(record.label)}  (${record.agent})`);
      console.log(`  kind: ${record.credential.kind}`);
      console.log(`  id:   ${record.id}`);
      if (record.credential.kind === 'api-key') console.log(`  ref:  ${record.credential.secretRef.value}`);
      else console.log(`  fingerprint: ${record.credential.fingerprint}`);
    });

  setHelpSections(accounts, { examples: `agents accounts\nagents accounts name work\nagents accounts name work --from claude@2.1.220\nagents accounts add cursor-work --provider cursor --auth api-key\nagents accounts add cursor-work --provider cursor --auth api-key --from-secrets cursor-bundle:API_KEY\nagents accounts set-key cursor-work\nagents accounts inspect cursor-work\nagents run claude --account work`, notes: 'For managed-login accounts: run the harness and complete its normal login first, then name it. For api-key accounts: keys are stored in the device keychain and never written to YAML.' });
}
