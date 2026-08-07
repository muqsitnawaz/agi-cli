/**
 * `agents accounts` — name signed-in identities (labels) and bind them to
 * installed harness versions per device. See docs/00-concepts.md (Logical
 * account labels) and the accounts library under lib/accounts/.
 */
import type { Command } from 'commander';
import chalk from 'chalk';

import { resolveAgentName, getAccountInfo, formatAgentError, agentLabel } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { getVersionHomePath, listInstalledVersions, getGlobalDefault } from '../lib/versions.js';
import { machineId } from '../lib/machine-id.js';
import { setHelpSections } from '../lib/help.js';
import { loginHint } from '../lib/signin-badge.js';
import { accountFingerprint, isLabelableAgent } from '../lib/accounts/capability.js';
import {
  readAccountLabels,
  writeAccountLabels,
  setLabelIdentity,
  renameLabel,
  removeLabel,
} from '../lib/accounts/registry.js';
import {
  readAccountBindings,
  writeAccountBindings,
  setBinding,
  removeBinding,
  ALL_VERSIONS_MARKER,
} from '../lib/accounts/bindings.js';

/** A parsed `agent[@version|@*]` attach/detach target. */
interface Target {
  agent: AgentId;
  /** Concrete version, `'*'` for version-global, or undefined (bare agent -> `'*'`). */
  version?: string;
}

function parseTarget(raw: string): Target {
  const at = raw.indexOf('@');
  const name = at === -1 ? raw : raw.slice(0, at);
  const agent = resolveAgentName(name);
  if (!agent) throw new Error(formatAgentError(name));
  if (!isLabelableAgent(agent)) {
    throw new Error(`${agentLabel(agent)} does not support account labels (no inspectable per-version identity).`);
  }
  const version = at === -1 ? undefined : raw.slice(at + 1);
  if (version === '') throw new Error(`Expected <agent>@<version> or <agent>@*, got '${raw}'.`);
  return { agent, version };
}

/** Whether a target means "every installed version of this harness". */
function isVersionGlobal(t: Target): boolean {
  return t.version === undefined || t.version === ALL_VERSIONS_MARKER;
}

/**
 * The installed version to read the identity from. For a concrete `@version`
 * that exact version (must be installed); for a version-global target the global
 * default, else the first installed version. Throws when nothing is installed.
 */
function identitySourceVersion(t: Target): string {
  const installed = listInstalledVersions(t.agent);
  if (installed.length === 0) {
    throw new Error(`No installed ${agentLabel(t.agent)} versions. Run: agents add ${t.agent}@latest.`);
  }
  if (t.version && t.version !== ALL_VERSIONS_MARKER) {
    if (!installed.includes(t.version)) throw new Error(`${t.agent}@${t.version} is not installed.`);
    return t.version;
  }
  const dflt = getGlobalDefault(t.agent);
  return dflt && installed.includes(dflt) ? dflt : installed[0];
}

/**
 * Read the live identity of a target's source version and return its fingerprint,
 * failing loud when the version has no stable signed-in identity (a generic
 * "signed in" with no distinguishing key cannot be labeled — issue #2300).
 */
async function verifyIdentity(t: Target): Promise<{ fingerprint: string; source: string }> {
  const source = identitySourceVersion(t);
  const info = await getAccountInfo(t.agent, getVersionHomePath(t.agent, source));
  const fingerprint = accountFingerprint(t.agent, info);
  if (!info.signedIn || !fingerprint) {
    throw new Error(
      `${t.agent}@${source} has no stable signed-in identity. Sign in first (${loginHint(t.agent)}), then retry.`,
    );
  }
  return { fingerprint, source };
}

/**
 * Register a target's identity under `label` (verifying live) and bind it on
 * `device`. Shared by `label` and `attach`. When the label already names a
 * different identity for the harness, the write is refused — no binding changes.
 */
async function attachTarget(label: string, t: Target, device: string): Promise<void> {
  const { fingerprint, source } = await verifyIdentity(t);
  const registry = readAccountLabels();
  const existing = registry.labels[label]?.[t.agent];
  if (existing && existing !== fingerprint) {
    throw new Error(
      `${t.agent}@${source} is signed into a different identity than label '${label}' already names for ${t.agent}. No binding changed.`,
    );
  }
  setLabelIdentity(registry, label, t.agent, fingerprint); // enforces one-identity-per-label
  writeAccountLabels(registry);

  const bindings = readAccountBindings(device);
  if (isVersionGlobal(t)) {
    setBinding(bindings, label, t.agent, [ALL_VERSIONS_MARKER]);
  } else {
    const prior = bindings.bindings[label]?.[t.agent] ?? [];
    // A concrete version added on top of a '*' binding is a no-op (already covered).
    const next = prior.includes(ALL_VERSIONS_MARKER) ? prior : [...prior, source];
    setBinding(bindings, label, t.agent, next);
  }
  writeAccountBindings(bindings, device);

  const where = isVersionGlobal(t) ? `${t.agent}@* (all versions)` : `${t.agent}@${source}`;
  console.log(chalk.green(`Attached ${where} to '${label}' on ${device}.`));
}

export function registerAccountsCommand(program: Command): void {
  const accounts = program
    .command('accounts')
    .description('Name signed-in identities and bind them to installed harness versions per device');

  accounts
    .command('list')
    .description("Show labels, their per-harness identities, and this device's bindings")
    .option('--json', 'Machine-readable output')
    .option('--device <name>', 'Device whose bindings to show', machineId())
    .action(async (opts: { json?: boolean; device: string }) => {
      await runList(opts.device, !!opts.json);
    });

  accounts
    .command('label <label> <target>')
    .description('Name the identity signed into <agent>@<version> and bind that version')
    .option('--device <name>', 'Device to bind on', machineId())
    .action(async (label: string, target: string, opts: { device: string }) => {
      await attachTarget(label, parseTarget(target), opts.device);
    });

  accounts
    .command('attach <label> <targets...>')
    .description('Attach more versions/harnesses to an existing label (agent@version, agent@*, or bare agent)')
    .option('--device <name>', 'Device to bind on', machineId())
    .action(async (label: string, targets: string[], opts: { device: string }) => {
      if (!readAccountLabels().labels[label]) {
        throw new Error(`No account label '${label}'. Create it first: agents accounts label ${label} <agent>@<version>.`);
      }
      for (const raw of targets) await attachTarget(label, parseTarget(raw), opts.device);
    });

  accounts
    .command('detach <label> [targets...]')
    .description('Remove device bindings for a label (whole label, a harness, or a version)')
    .option('--device <name>', 'Device to detach on', machineId())
    .action((label: string, targets: string[] | undefined, opts: { device: string }) => {
      const bindings = readAccountBindings(opts.device);
      if (!targets || targets.length === 0) {
        if (!removeBinding(bindings, label)) throw new Error(`No bindings for '${label}' on ${opts.device}.`);
      } else {
        for (const raw of targets) {
          const t = parseTarget(raw);
          if (isVersionGlobal(t)) {
            removeBinding(bindings, label, t.agent);
          } else {
            const prior = bindings.bindings[label]?.[t.agent] ?? [];
            setBinding(bindings, label, t.agent, prior.filter((v) => v !== t.version));
          }
        }
      }
      writeAccountBindings(bindings, opts.device);
      console.log(chalk.green(`Detached from '${label}' on ${opts.device}.`));
    });

  accounts
    .command('rename <old> <new>')
    .description("Rename a label (central registry + this device's bindings)")
    .option('--device <name>', 'Device whose bindings to migrate', machineId())
    .action((oldLabel: string, newLabel: string, opts: { device: string }) => {
      const registry = readAccountLabels();
      renameLabel(registry, oldLabel, newLabel);
      writeAccountLabels(registry);
      const bindings = readAccountBindings(opts.device);
      if (bindings.bindings[oldLabel]) {
        bindings.bindings[newLabel] = bindings.bindings[oldLabel];
        delete bindings.bindings[oldLabel];
        writeAccountBindings(bindings, opts.device);
      }
      console.log(chalk.green(`Renamed '${oldLabel}' to '${newLabel}'.`));
    });

  accounts
    .command('remove <label>')
    .description("Remove a label from the central registry and this device's bindings")
    .option('--device <name>', 'Device whose bindings to clear', machineId())
    .action((label: string, opts: { device: string }) => {
      const registry = readAccountLabels();
      if (!removeLabel(registry, label)) throw new Error(`No account label '${label}'.`);
      writeAccountLabels(registry);
      const bindings = readAccountBindings(opts.device);
      if (removeBinding(bindings, label)) writeAccountBindings(bindings, opts.device);
      console.log(chalk.green(`Removed label '${label}'.`));
    });

  setHelpSections(accounts, {
    examples: `
    agents accounts label work claude@2.1.220
    agents accounts attach work claude@2.1.219 codex@0.146.0
    agents accounts attach work codex@*
    agents accounts list --json
    agents accounts detach work claude@2.1.219
    agents run claude --account work`,
    notes: `Labels store only SHA-256 identity fingerprints — tokens, emails, and provider account IDs are never copied. 'attach' verifies the version's current login before writing a binding. 'agent@*' (or a bare 'agent') binds every installed version of that harness (version-global auth). 'agents run --account <label>' runs only a verified bound version and never falls back to another identity.`,
  });
}

/** Build and print the `accounts list` view for one device. */
async function runList(device: string, json: boolean): Promise<void> {
  const registry = readAccountLabels();
  const bindings = readAccountBindings(device);
  const isLocal = device.toLowerCase() === machineId();

  interface DriftRow { agent: AgentId; version: string; issue: 'signed-out' | 'mismatch' }
  const view: Record<string, {
    identities: Record<string, string>;
    bindings: Record<string, string[]>;
    drift: DriftRow[];
  }> = {};

  const labels = new Set([...Object.keys(registry.labels), ...Object.keys(bindings.bindings)]);
  for (const label of [...labels].sort()) {
    const identities = { ...(registry.labels[label] ?? {}) } as Record<string, string>;
    const labelBindings = { ...(bindings.bindings[label] ?? {}) } as Record<string, string[]>;
    const drift: DriftRow[] = [];
    // Live drift is only checkable for installs on THIS machine.
    if (isLocal) {
      for (const [agent, versions] of Object.entries(labelBindings) as [AgentId, string[]][]) {
        const expected = registry.labels[label]?.[agent];
        if (!expected) continue;
        const concrete = versions.includes(ALL_VERSIONS_MARKER)
          ? listInstalledVersions(agent)
          : versions.filter((v) => listInstalledVersions(agent).includes(v));
        for (const version of concrete) {
          const info = await getAccountInfo(agent, getVersionHomePath(agent, version)).catch(() => null);
          if (!info || !info.signedIn) drift.push({ agent, version, issue: 'signed-out' });
          else if (accountFingerprint(agent, info) !== expected) drift.push({ agent, version, issue: 'mismatch' });
        }
      }
    }
    view[label] = { identities, bindings: labelBindings, drift };
  }

  if (json) {
    console.log(JSON.stringify({ device, local: isLocal, labels: view }, null, 2));
    return;
  }

  const entries = Object.entries(view);
  if (entries.length === 0) {
    console.log(chalk.gray('No account labels configured. Create one: agents accounts label <name> <agent>@<version>.'));
    return;
  }
  for (const [label, entry] of entries) {
    const harnesses = Object.keys(entry.identities);
    console.log(chalk.cyan(label) + chalk.gray(harnesses.length ? `  (${harnesses.join(', ')})` : '  (no identities)'));
    for (const [agent, versions] of Object.entries(entry.bindings)) {
      const shown = versions.includes(ALL_VERSIONS_MARKER) ? 'all versions' : versions.join(', ');
      console.log(`    ${agent}: ${shown}`);
    }
    for (const d of entry.drift) {
      console.log(chalk.yellow(`    ! ${d.agent}@${d.version} ${d.issue === 'signed-out' ? 'signed out' : 'signed into another identity'}`));
    }
  }
}
