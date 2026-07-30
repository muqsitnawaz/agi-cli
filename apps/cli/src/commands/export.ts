/**
 * `agents export <agent>[@<version>]` — copy an isolated install's config out to the
 * user's real `~/.<agent>`.
 *
 * The exit door for `--isolated`. Configure a sandboxed copy, then promote that
 * config to your normal setup — or take it with you and delete agents-cli. The copy
 * strips symlinks into `~/.agents`, so what lands in `~/.<agent>` keeps working with
 * no trace of this CLI.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { confirm, select } from '@inquirer/prompts';

import { AGENTS, agentLabel, formatAgentError, resolveAgentName } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { listInstalledVersions, isVersionIsolated } from '../lib/versions.js';
import { planExport, executeExport } from '../lib/export.js';
import type { ExportPlan } from '../lib/export.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

function isolatedVersions(agent: AgentId): string[] {
  return listInstalledVersions(agent).filter((v) => isVersionIsolated(agent, v));
}

/** Explain a blocker in terms of what the user should do instead. */
function reportBlocker(plan: ExportPlan): void {
  const label = agentLabel(plan.agent);
  const b = plan.blocker!;
  switch (b.kind) {
    case 'not-installed':
      console.log(chalk.red(`${label}@${plan.version} is not installed.`));
      console.log(chalk.gray(`  Installed: ${listInstalledVersions(plan.agent).join(', ') || 'none'}`));
      break;
    case 'not-isolated':
      console.log(chalk.yellow(`${label}@${plan.version} is not an isolated install.`));
      console.log(chalk.gray(`  A normal install's config already IS ${plan.dest} (adoption symlinks it),`));
      console.log(chalk.gray('  so there is nothing to export. To un-adopt it, use: agents uninstall'));
      break;
    case 'no-config':
      console.log(chalk.yellow(`${label}@${plan.version} has no config to export yet (${b.source} is empty).`));
      console.log(chalk.gray(`  Run it once first: agents run ${plan.agent}@${plan.version}`));
      break;
    case 'dest-adopted':
      console.log(chalk.red(`${b.realPath} is managed by agents-cli (adopted by ${label}@${b.adoptedVersion}).`));
      console.log(chalk.gray('  Exporting would write into that version\'s home, not your real config.'));
      console.log(chalk.gray(`  Release it first: agents uninstall  (or agents remove ${plan.agent}@${b.adoptedVersion})`));
      break;
  }
}

function printPlan(plan: ExportPlan): void {
  const label = agentLabel(plan.agent);
  console.log(chalk.bold(`Export ${label}@${plan.version} -> ${plan.dest}\n`));
  console.log(`  ${chalk.gray('from')}  ${plan.source}`);
  console.log(`  ${chalk.gray('to')}    ${plan.dest}`);
  if (plan.entries.length > 0) {
    const shown = plan.entries.slice(0, 12).join(', ');
    const more = plan.entries.length > 12 ? `, +${plan.entries.length - 12} more` : '';
    console.log(`  ${chalk.gray('items')} ${shown}${more}`);
  }
  console.log();
  switch (plan.destKind) {
    case 'real-dir':
      console.log(chalk.yellow(`  ${plan.dest} already exists and will be REPLACED.`));
      console.log(chalk.gray(`  Your current config is moved to: ${plan.backupPath}`));
      break;
    case 'foreign-symlink':
      console.log(chalk.yellow(`  ${plan.dest} is a symlink agents-cli does not own; it will be removed.`));
      console.log(chalk.gray('  Its target is left untouched — inspect it first if you are unsure.'));
      break;
    case 'absent':
      console.log(chalk.gray(`  ${plan.dest} does not exist yet; it will be created.`));
      break;
  }
  console.log(chalk.gray('\n  Symlinks into ~/.agents are stripped, so the result stands alone.'));
}

export function registerExportCommand(program: Command): void {
  program
    .command('export <spec>')
    .description('Copy an isolated install\'s config out to your real ~/.<agent>')
    .option('--dry-run', 'Show what would change without writing anything')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .addHelpText(
      'after',
      `
Examples:
  # Promote an isolated copy's config to your normal setup
  agents export codex@0.144.6

  # Only one isolated copy? The version can be omitted
  agents export codex

  # See exactly what would change first
  agents export codex --dry-run

Leaving agents-cli entirely: export each agent you care about, then uninstall.
The exported config contains no links back into ~/.agents.
`,
    )
    .action(async (spec: string, options: { dryRun?: boolean; yes?: boolean }) => {
      const [rawAgent, rawVersion] = spec.split('@');
      const agent = resolveAgentName(rawAgent);
      if (!agent) {
        console.error(chalk.red(formatAgentError(rawAgent)));
        process.exit(1);
      }

      let version = rawVersion;
      if (!version) {
        const candidates = isolatedVersions(agent);
        if (candidates.length === 0) {
          console.log(chalk.yellow(`No isolated ${agentLabel(agent)} installs to export.`));
          console.log(chalk.gray(`  Create one with: agents add ${agent}@<version> --isolated`));
          return;
        }
        if (candidates.length === 1) {
          version = candidates[0];
        } else if (isInteractiveTerminal()) {
          version = await select({
            message: `Which isolated ${agentLabel(agent)} version?`,
            choices: candidates.map((v) => ({ name: v, value: v })),
          }).catch((err) => {
            if (isPromptCancelled(err)) process.exit(130);
            throw err;
          });
        } else {
          console.error(chalk.red(`${agentLabel(agent)} has several isolated installs; name one.`));
          console.error(chalk.gray(`  ${candidates.map((v) => `agents export ${agent}@${v}`).join('\n  ')}`));
          process.exit(1);
        }
      }

      const plan = planExport(agent, version!, Date.now());
      if (plan.blocker) {
        reportBlocker(plan);
        process.exit(1);
      }

      printPlan(plan);

      if (options.dryRun) {
        console.log(chalk.gray('\nDry run — nothing was written.'));
        return;
      }

      if (!options.yes) {
        if (!isInteractiveTerminal()) {
          console.error(chalk.red('\nRefusing to overwrite without confirmation in a non-interactive shell.'));
          console.error(chalk.gray('  Re-run with --yes once you have checked --dry-run.'));
          process.exit(1);
        }
        const ok = await confirm({ message: `Write ${plan.dest}?`, default: false }).catch((err) => {
          if (isPromptCancelled(err)) process.exit(130);
          throw err;
        });
        if (!ok) {
          console.log(chalk.gray('Aborted.'));
          return;
        }
      }

      const result = executeExport(plan);
      if (!result.exported) {
        console.error(chalk.red(`Export failed: ${result.errors.join('; ')}`));
        process.exit(1);
      }
      console.log(chalk.green(`\nExported to ${result.dest}`));
      if (result.backupPath) {
        console.log(chalk.gray(`  Previous config kept at: ${result.backupPath}`));
      }
      console.log(chalk.gray(`  ${AGENTS[plan.agent].cliCommand} now reads this config directly.`));
    });
}
