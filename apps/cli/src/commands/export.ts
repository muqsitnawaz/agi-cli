/**
 * `agents export <agent>[@<version>]` — copy an isolated install's config out to the
 * user's real `~/.<agent>`.
 *
 * The exit door for `--isolated`. Default is additive: your files are never modified,
 * and anything that collides is written beside yours so you can diff and take what you
 * want. A receipt records what came from the export, so "which of these are mine?" has
 * an answer and the whole thing can be undone.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { confirm, select } from '@inquirer/prompts';

import { AGENTS, agentLabel, formatAgentError, resolveAgentName } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { listInstalledVersions, isVersionIsolated } from '../lib/versions.js';
import { planExport, executeExport, CONFLICT_SUFFIX } from '../lib/export.js';
import type { ExportPlan, ExportMode } from '../lib/export.js';
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

/** Unified diff between the user's file and the incoming one, via git. */
function printDiff(existing: string, incoming: string): void {
  try {
    execFileSync('git', ['diff', '--no-index', '--color', '--', existing, incoming], {
      stdio: ['ignore', 'inherit', 'ignore'],
    });
  } catch {
    // git diff --no-index exits 1 when files differ; output already streamed.
  }
}

function printPlan(plan: ExportPlan, opts: { diff?: boolean }): void {
  const label = agentLabel(plan.agent);
  console.log(chalk.bold(`Export ${label}@${plan.version} -> ${plan.dest}  ${chalk.gray(`[${plan.mode}]`)}\n`));
  console.log(`  ${chalk.gray('from')}  ${plan.source}`);
  console.log(`  ${chalk.gray('to')}    ${plan.stagedPath ?? plan.dest}`);
  console.log();

  if (plan.mode === 'replace') {
    console.log(chalk.yellow(`  Replacing ${plan.dest} wholesale — ${plan.writes.length} file(s).`));
    if (plan.backupPath) console.log(chalk.gray(`  Your current config moves to: ${plan.backupPath}`));
    else if (plan.destKind === 'foreign-symlink') {
      console.log(chalk.yellow(`  ${plan.dest} is a symlink agents-cli does not own; it will be removed.`));
      console.log(chalk.gray('  Its target is left untouched.'));
    }
  } else if (plan.mode === 'staged') {
    console.log(chalk.gray(`  Writing ${plan.writes.length} file(s) into ${plan.stagedPath}.`));
    console.log(chalk.gray('  Nothing is activated — your config is untouched.'));
  } else {
    if (plan.writes.length > 0) {
      console.log(chalk.green(`  ${plan.writes.length} new file(s) will be added:`));
      for (const w of plan.writes.slice(0, 15)) console.log(chalk.gray(`      + ${w.rel}`));
      if (plan.writes.length > 15) console.log(chalk.gray(`      + ${plan.writes.length - 15} more`));
    } else {
      console.log(chalk.gray('  No new files to add.'));
    }
    if (plan.conflicts.length > 0) {
      console.log();
      console.log(chalk.yellow(`  ${plan.conflicts.length} file(s) you already have — YOURS ARE NOT MODIFIED.`));
      console.log(chalk.gray(`  The incoming version is written beside each as *${CONFLICT_SUFFIX}:`));
      for (const c of plan.conflicts.slice(0, 15)) console.log(chalk.gray(`      ~ ${c.rel}`));
      if (plan.conflicts.length > 15) console.log(chalk.gray(`      ~ ${plan.conflicts.length - 15} more`));
    }
  }

  if (opts.diff && plan.conflicts.length > 0) {
    for (const c of plan.conflicts) {
      console.log(chalk.bold(`\n─── ${c.rel} ───`));
      printDiff(c.existing!, c.source);
    }
  }

  console.log(chalk.gray(`\n  Receipt: ${plan.receiptPath}`));
}

export function registerExportCommand(program: Command): void {
  program
    .command('export <spec>')
    .description('Copy an isolated install\'s config out to your real ~/.<agent>')
    .option('--replace', 'Replace your config wholesale (yours is backed up) instead of merging')
    .option('--staged', 'Write into ~/.<agent>/.agents-export-<ts>/ and activate nothing')
    .option('--diff', 'Show a unified diff for each file you already have')
    .option('--dry-run', 'Show what would change without writing anything')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .addHelpText(
      'after',
      `
Modes:
  (default)   merge   — additive. Your files are NEVER modified. Anything that
                        collides is written beside yours as <name>${CONFLICT_SUFFIX}
                        so you can diff and take the parts you want.
  --replace           — the isolated config becomes ~/.<agent>; yours is moved to
                        backups/<agent>/<ts>. For promoting a sandbox wholesale.
  --staged            — dump the tree into ~/.<agent>/.agents-export-<ts>/ and
                        activate nothing. For inspecting first.

Every mode writes a receipt to ~/.<agent>/.agents-cli-export.json listing exactly
what came from the export — so you can tell your settings from the CLI's, and undo it.

Examples:
  agents export codex --dry-run          # see the plan
  agents export codex --diff             # ...and the deltas on colliding files
  agents export codex                    # additive; nothing of yours changes
  agents export codex@0.144.6 --replace  # promote the sandbox wholesale

Note: file CONTENTS are never auto-merged. The TOML parser here does not preserve
comments, so merging keys would silently delete them. You get both files and a diff.
`,
    )
    .action(async (spec: string, options: { replace?: boolean; staged?: boolean; diff?: boolean; dryRun?: boolean; yes?: boolean }) => {
      if (options.replace && options.staged) {
        console.error(chalk.red('--replace and --staged are mutually exclusive; pass only one.'));
        process.exit(1);
      }
      const mode: ExportMode = options.replace ? 'replace' : options.staged ? 'staged' : 'merge';

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

      const timestamp = Date.now();
      const plan = planExport(agent, version!, timestamp, mode);
      if (plan.blocker) {
        reportBlocker(plan);
        process.exit(1);
      }

      printPlan(plan, { diff: options.diff });

      if (options.dryRun) {
        console.log(chalk.gray('\nDry run — nothing was written.'));
        return;
      }

      // Only `--replace` can destroy anything, so it is the only mode that demands
      // confirmation. merge and staged are additive by construction.
      if (mode === 'replace' && !options.yes) {
        if (!isInteractiveTerminal()) {
          console.error(chalk.red('\nRefusing to replace your config without confirmation in a non-interactive shell.'));
          console.error(chalk.gray('  Re-run with --yes once you have checked --dry-run.'));
          process.exit(1);
        }
        const ok = await confirm({ message: `Replace ${plan.dest}?`, default: false }).catch((err) => {
          if (isPromptCancelled(err)) process.exit(130);
          throw err;
        });
        if (!ok) {
          console.log(chalk.gray('Aborted.'));
          return;
        }
      }

      const result = executeExport(plan, timestamp);
      if (!result.exported) {
        console.error(chalk.red(`Export failed: ${result.errors.join('; ')}`));
        process.exit(1);
      }

      console.log();
      if (result.written.length > 0) console.log(chalk.green(`Added ${result.written.length} file(s) to ${result.dest}`));
      if (result.conflicts.length > 0) {
        console.log(chalk.yellow(`${result.conflicts.length} of your file(s) were left untouched; incoming copies written as *${CONFLICT_SUFFIX}`));
        console.log(chalk.gray(`  Compare them with: agents export ${agent}@${version} --diff --dry-run`));
      }
      if (result.backupPath) console.log(chalk.gray(`Previous config kept at: ${result.backupPath}`));
      if (result.stagedPath) console.log(chalk.gray(`Staged (nothing activated): ${result.stagedPath}`));
      console.log(chalk.gray(`Receipt: ${result.receiptPath}`));
      if (mode !== 'staged') {
        console.log(chalk.gray(`  ${AGENTS[plan.agent].cliCommand} reads this config directly.`));
      }
    });
}
