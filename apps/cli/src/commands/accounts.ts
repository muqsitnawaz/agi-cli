import type { Command } from 'commander';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { setHelpSections } from '../lib/help.js';
import { readMeta, updateMeta } from '../lib/state.js';
import type { AgentId } from '../lib/types.js';
import { ALL_AGENT_IDS, getAccountInfo } from '../lib/agents.js';
import { getVersionHomePath, listInstalledVersions } from '../lib/versions.js';
import { pushBundleToHost } from '../lib/secrets/push.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { runDevicesAccounts } from './ssh.js';
import { discoverNativeAccounts, type NativeAccountCatalogEntry } from '../lib/account-catalog.js';
import {
  findAliasByName,
  readNativeAliases,
  removeNativeAlias,
  renameNativeAlias,
  setNativeAlias,
} from '../lib/account-aliases.js';
import { readAndResolveBundleEnv } from '../lib/secrets/bundles.js';
import { getAccountProvider, listAccountProviders, type AccountAuthKind } from '../lib/account-provider-registry.js';
import { assertAccountName } from '../lib/account-schema.js';
import { addAccount, findAccount, inspectAccount, readAccountRegistry, removeAccount, renameAccount, setAccountSecret } from '../lib/account-registry.js';

export function parseBundleKey(raw: string): { bundle: string; key: string } {
  const colon = raw.indexOf(':');
  if (colon < 1 || colon === raw.length - 1) throw new Error(`Expected bundle:key, got '${raw}'.`);
  return { bundle: raw.slice(0, colon), key: raw.slice(colon + 1) };
}

function secretFromBundle(raw: string): string {
  const { bundle, key } = parseBundleKey(raw);
  return readAndResolveBundleEnv(bundle, { keys: [key], keyMode: 'storage', agentOnly: true, caller: 'accounts import' }).env[key];
}

function publicAccount(account: ReturnType<typeof inspectAccount>) {
  return { kind: 'provider' as const, id: account.id, name: account.name, provider: account.provider, auth: account.auth, baseUrl: account.baseUrl, policy: account.policy, secretPresent: account.secretPresent };
}

/**
 * The one account namespace: a new provider account or native alias name must
 * not already belong to either store. The command layer owns this check so the
 * two lib stores ([[account-registry]], [[account-aliases]]) stay acyclic.
 */
function assertUnifiedNameFree(name: string): void {
  assertAccountName(name);
  if (findAccount(name)) throw new Error(`Account '${name}' already exists.`);
  if (findAliasByName(name, readNativeAliases())) throw new Error(`A native login is already named '${name}'.`);
}

export function assertAgentTarget(target: string): AgentId {
  if (target.includes('@')) throw new Error(`Attach a harness by name (e.g. 'claude'), not a version — a default account applies to every version of that harness.`);
  if (!ALL_AGENT_IDS.includes(target as AgentId)) throw new Error(`Unknown harness '${target}'.`);
  return target as AgentId;
}

/** Harnesses whose default account is this credential account (by id or name). */
function attachedAgents(account: { id: string; name: string }, meta = readMeta()): AgentId[] {
  const defaults = meta.accounts?.defaults ?? {};
  return (Object.keys(defaults) as AgentId[]).filter(agent => defaults[agent] === account.id || defaults[agent] === account.name).sort();
}

/**
 * The one renderer behind `accounts` (list + view). It assembles both stores —
 * provider credential accounts and native logins with their aliases — into a
 * single set of rows, so text and `--json` never drift apart. `inspectAccount`
 * carries per-device credential presence for the provider rows.
 */
function providerRows(): Array<ReturnType<typeof publicAccount>> {
  return Object.values(readAccountRegistry().accounts)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(account => publicAccount(inspectAccount(account.name)));
}

function renderProviderRow(account: ReturnType<typeof publicAccount>): string {
  const present = account.secretPresent ? chalk.green('ready') : chalk.red('missing on this device');
  const label = chalk.cyan(account.name);
  const bound = attachedAgents(account);
  const usedBy = bound.length ? `  ${chalk.gray(`→ ${bound.join(', ')}`)}` : '';
  return `  ${label}  ${account.provider}  ${account.auth}  ${present}${usedBy}`;
}

function renderNativeRow(entry: NativeAccountCatalogEntry): string {
  const label = entry.alias ? `${chalk.cyan(entry.alias)}  ${chalk.gray(entry.display)}` : chalk.cyan(entry.display);
  return `  ${label}  ${entry.agent}  ${entry.versions.join(', ')}`;
}

async function printAccounts(json: boolean, fleet = false): Promise<void> {
  if (fleet) return runDevicesAccounts({ json });
  const providers = providerRows();
  const native = await discoverNativeAccounts();
  if (json) {
    console.log(JSON.stringify([...providers, ...native], null, 2));
    return;
  }
  console.log(chalk.bold('Provider account bundles\n'));
  if (!providers.length) console.log(chalk.gray("  None. Add one with 'agents accounts add <name> --provider <provider> --auth <type>'."));
  for (const account of providers) console.log(renderProviderRow(account));
  console.log(chalk.bold('\nNative harness logins\n'));
  if (!native.length) console.log(chalk.gray("  No signed-in native accounts found. Name one with 'agents accounts name <agent> <name>'."));
  for (const entry of native) console.log(renderNativeRow(entry));
}

function parseAuth(raw: string): AccountAuthKind {
  if (raw === 'api-key' || raw === 'setup-token' || raw === 'bearer-token') return raw;
  throw new Error(`Unsupported auth type '${raw}'. Use api-key, setup-token, or bearer-token.`);
}

export function parseAgentSource(source: string): { agent: AgentId; version?: string } {
  const [agentRaw, version] = source.split('@', 2);
  if (!ALL_AGENT_IDS.includes(agentRaw as AgentId)) throw new Error(`Unknown harness '${agentRaw}'. Name a source like 'claude' or 'claude@2.1.220'.`);
  return { agent: agentRaw as AgentId, version: version || undefined };
}

/** Resolve the identity fingerprint of a signed-in native login to name it. */
async function resolveNativeIdentity(agent: AgentId, version?: string): Promise<string> {
  if (version) {
    if (!listInstalledVersions(agent).includes(version)) throw new Error(`${agent}@${version} is not installed.`);
    const info = await getAccountInfo(agent, getVersionHomePath(agent, version));
    const identity = info.accountKey ?? info.email?.toLowerCase() ?? null;
    if (!info.signedIn || !identity) throw new Error(`${agent}@${version} is not signed in, so there is no identity to name.`);
    return identity;
  }
  const matches = (await discoverNativeAccounts()).filter(entry => entry.agent === agent);
  if (!matches.length) throw new Error(`No signed-in ${agent} login found. Sign in first, or name a specific version like '${agent}@<version>'.`);
  if (matches.length > 1) {
    const which = matches.map(m => `${agent}@${m.versions[0]} (${m.display})`).join(', ');
    throw new Error(`${agent} has more than one signed-in identity: ${which}. Name a specific version like '${agent}@<version>'.`);
  }
  return matches[0].id;
}

function printProviderView(name: string, json: boolean): void {
  const account = publicAccount(inspectAccount(name));
  if (json) return void console.log(JSON.stringify(account, null, 2));
  console.log(`${chalk.bold(account.name)}  ${account.provider}`);
  console.log(`  kind: provider credential`);
  console.log(`  auth: ${account.auth}`);
  console.log(`  id: ${account.id}`);
  console.log(`  policy: ${account.policy}`);
  if (account.baseUrl) console.log(`  base url: ${account.baseUrl}`);
  console.log(`  credential: ${account.secretPresent ? 'present on this device' : 'missing on this device'}`);
  const bound = attachedAgents(account);
  if (bound.length) console.log(`  default for: ${bound.join(', ')}`);
}

export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Browse native logins and manage provider account bundles')
    .option('--json', 'Machine-readable account metadata')
    .option('--fleet', 'Show harness-native signed-in identities across reachable devices')
    .action((o: { json?: boolean; fleet?: boolean }) => printAccounts(!!o.json, !!o.fleet));
  accounts.command('list').description('List credential accounts and named native logins').option('--json', 'Machine-readable account metadata').action((o: { json?: boolean }, command: Command) => printAccounts(!!(o.json || command.optsWithGlobals().json)));

  accounts.command('add <name>')
    .description('Add a durable API key, setup token, or bearer token')
    .requiredOption('--provider <provider>', `Credential provider (${listAccountProviders().join(', ')})`)
    .requiredOption('--auth <type>', 'Credential type: api-key | setup-token | bearer-token')
    .option('--base-url <url>', 'Optional endpoint override stored with the account')
    .option('--from-secrets <bundle:key>', 'Import from an existing agents secrets entry')
    .action(async (name: string, o: { provider: string; auth: string; baseUrl?: string; fromSecrets?: string }) => {
      assertUnifiedNameFree(name);
      const auth = parseAuth(o.auth);
      const provider = getAccountProvider(o.provider);
      if (!provider.authKinds.includes(auth)) throw new Error(`Provider '${provider.provider}' does not support ${auth}. Supported: ${provider.authKinds.join(', ')}.`);
      const secret = o.fromSecrets ? secretFromBundle(o.fromSecrets) : await password({ message: `Enter ${provider.provider} ${auth} for '${name}':` });
      const account = addAccount(name, provider.provider, auth, secret, undefined, { baseUrl: o.baseUrl });
      console.log(chalk.green(`Added ${account.provider} ${account.auth} account '${account.name}'.`));
      console.log(chalk.gray(`Secret bundle '${account.name}' is the account and uses policy never, so agent launches never request Touch ID.`));
    });

  accounts.command('name <source> <name>')
    .description('Give a durable name to a signed-in native harness login')
    .action(async (source: string, name: string) => {
      assertUnifiedNameFree(name);
      const { agent, version } = parseAgentSource(source);
      const identity = await resolveNativeIdentity(agent, version);
      const alias = setNativeAlias({ name, agent, identity });
      console.log(chalk.green(`Named the ${agent} login '${alias.identity}' as '${alias.name}'.`));
      console.log(chalk.gray('The name follows the identity, not a version, so it survives version changes and shows in agents view.'));
    });

  accounts.command('set-key <name>')
    .description('Rotate an account credential without changing its identity')
    .option('--from-secrets <bundle:key>', 'Import from an existing agents secrets entry')
    .action(async (name: string, o: { fromSecrets?: string }) => {
      const account = findAccount(name);
      if (!account) throw new Error(`Unknown account '${name}'.`);
      const secret = o.fromSecrets ? secretFromBundle(o.fromSecrets) : await password({ message: `Enter new ${account.provider} ${account.auth} for '${name}':` });
      setAccountSecret(name, secret);
      console.log(chalk.green(`Updated credential for account '${name}'.`));
    });

  accounts.command('inspect <name>').description('Show safe account metadata').option('--json', 'Machine-readable output').action((name: string, o: { json?: boolean }, command: Command) => {
    printProviderView(name, !!(o.json || command.optsWithGlobals().json));
  });

  accounts.command('view <account>')
    .description('Show one account: a provider credential or a named native login')
    .option('--json', 'Machine-readable output')
    .action(async (accountName: string, o: { json?: boolean }, command: Command) => {
      const json = !!(o.json || command.optsWithGlobals().json);
      if (findAccount(accountName)) return printProviderView(accountName, json);
      const alias = findAliasByName(accountName, readNativeAliases());
      if (!alias) throw new Error(`Unknown account '${accountName}'.`);
      const live = (await discoverNativeAccounts()).find(entry => entry.aliasId === alias.id);
      if (json) return void console.log(JSON.stringify({ kind: 'native', id: alias.id, name: alias.name, agent: alias.agent, identity: alias.identity ?? null, versions: live?.versions ?? [], email: live?.email ?? null }, null, 2));
      console.log(`${chalk.bold(alias.name)}  ${alias.agent}`);
      console.log(`  kind: native login`);
      console.log(`  id: ${alias.id}`);
      if (alias.identity) console.log(`  identity: ${alias.identity}`);
      console.log(`  signed-in versions: ${live?.versions.length ? live.versions.join(', ') : chalk.red('none on this device')}`);
    });

  accounts.command('rename <old> <new>').description('Rename an account or named native login without changing its stable id').action((oldName: string, newName: string) => {
    if (findAccount(oldName)) {
      assertUnifiedNameFree(newName);
      renameAccount(oldName, newName);
    } else if (findAliasByName(oldName, readNativeAliases())) {
      assertUnifiedNameFree(newName);
      renameNativeAlias(oldName, newName);
    } else {
      throw new Error(`Unknown account '${oldName}'.`);
    }
    console.log(chalk.green(`Renamed '${oldName}' to '${newName}'.`));
  });

  accounts.command('remove <name>').description('Remove a provider account or a named native login').action((name: string) => {
    const account = findAccount(name);
    if (account) {
      const bound = attachedAgents(account);
      if (bound.length) throw new Error(`Account '${account.name}' is attached to: ${bound.join(', ')}. Detach it first with 'agents accounts detach ${account.name} <harness>'.`);
      removeAccount(name); // also refuses when a harness profile still references it
      console.log(chalk.green(`Removed account '${name}' and its device-local credential.`));
      return;
    }
    if (findAliasByName(name, readNativeAliases())) {
      removeNativeAlias(name);
      console.log(chalk.green(`Removed native login alias '${name}'. The harness login itself is untouched.`));
      return;
    }
    throw new Error(`Unknown account '${name}'.`);
  });

  accounts.command('attach <account> <target>')
    .description('Use a credential account as a harness default (until --account overrides it)')
    .action((accountName: string, target: string) => {
      const account = findAccount(accountName);
      if (!account) {
        if (findAliasByName(accountName, readNativeAliases())) throw new Error(`'${accountName}' is a native login alias. Native identities are chosen by the harness's own login, not attached as a credential default.`);
        throw new Error(`Unknown provider account '${accountName}'.`);
      }
      const agent = assertAgentTarget(target);
      getAccountProvider(account.provider).envFor(agent, account.auth); // provider/harness compatibility
      // The binding follows the stable id, so renaming the bundle cannot strand
      // a bare run on a deleted label. findAccount accepts ids and names.
      updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: { ...meta.accounts?.defaults, [agent]: account.id } } }));
      console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
    });

  accounts.command('detach <account> <target>')
    .description('Stop using a credential account as a harness default')
    .action((accountName: string, target: string) => {
      const account = findAccount(accountName);
      if (!account) throw new Error(`Unknown provider account '${accountName}'.`);
      const agent = assertAgentTarget(target);
      const current = readMeta().accounts?.defaults?.[agent];
      if (current !== account.id && current !== account.name) throw new Error(`Account '${account.name}' is not attached to ${agent}.`);
      updateMeta(meta => {
        const defaults = { ...meta.accounts?.defaults };
        delete defaults[agent];
        return { ...meta, accounts: { ...meta.accounts, defaults } };
      });
      console.log(chalk.green(`Detached '${account.name}' from ${agent}. It returns to native login or balanced selection.`));
    });

  // set-default / clear-default are retained as the harness-first spelling of
  // attach / detach so existing scripts keep working.
  accounts.command('set-default <agent> <name>')
    .description('Use a provider account for a harness when --account is omitted (alias of attach)')
    .action((agentRaw: string, name: string) => {
      const account = findAccount(name);
      if (!account) throw new Error(`Unknown provider account '${name}'.`);
      const agent = assertAgentTarget(agentRaw);
      getAccountProvider(account.provider).envFor(agent, account.auth);
      updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: { ...meta.accounts?.defaults, [agent]: account.id } } }));
      console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
    });

  accounts.command('clear-default <agent>')
    .description('Return a harness to native login or balanced account selection (alias of detach)')
    .action((agentRaw: string) => {
      const agent = assertAgentTarget(agentRaw);
      updateMeta(meta => {
        const defaults = { ...meta.accounts?.defaults };
        delete defaults[agent];
        return { ...meta, accounts: { ...meta.accounts, defaults } };
      });
      console.log(chalk.green(`Cleared the default account for ${agent}.`));
    });

  accounts.command('sync <account> [device]')
    .description('Copy one provider account bundle to a worker device')
    .option('--device <device>', 'Destination device or SSH host (or pass it positionally)')
    .option('--force', 'Replace matching keys on the destination')
    .action((accountName: string, deviceArg: string | undefined, o: { device?: string; force?: boolean }) => {
      const device = deviceArg ?? o.device;
      if (!device) throw new Error('Name a destination device: agents accounts sync <account> <device>.');
      if (findAliasByName(accountName, readNativeAliases()) && !findAccount(accountName)) {
        throw new Error(`'${accountName}' is a native login alias — there is no credential bundle to copy. Native logins are per-device by design.`);
      }
      const account = findAccount(accountName);
      if (!account) throw new Error(`Unknown provider account '${accountName}'.`);
      const remoteBackend = resolveRemoteOsSync(device) === 'win32' ? 'keychain' : 'file';
      const literalValues = {
        ACCOUNT_ID: account.id,
        PROVIDER: account.provider,
        AUTH_TYPE: account.auth,
        ...(account.baseUrl ? { BASE_URL: account.baseUrl } : {}),
      };
      const result = pushBundleToHost(account.name, device, {
        remoteBackend,
        force: o.force,
        operation: 'accounts sync',
        policyNever: true,
        agentOnly: false,
        literalValues,
      });
      if (!result.ok) throw new Error(`${result.message}\nRetry: agents accounts sync ${account.name} ${device}${o.force ? ' --force' : ''}`);
      console.log(chalk.green(`${account.name} synced to ${device} (${result.keyCount} keys, ${remoteBackend} backend, policy never).`));
    });

  setHelpSections(accounts, {
    examples: `agents accounts name claude@2.1.220 work
agents accounts add openrouter-work --provider openrouter --auth api-key --from-secrets openrouter.ai:OPENROUTER_API_KEY
agents accounts attach openrouter-work deepseek
agents accounts view work
agents accounts set-key openrouter-work
agents accounts sync openrouter-work yosemite-s0
agents run deepseek --account openrouter-work`,
    notes: 'An account is one authorization identity. `name` labels a harness-native login (metadata only); `add` stores a durable provider credential. Native logins stay owned by each harness — agents-cli never copies their tokens and cannot sync them across devices.',
  });
}
