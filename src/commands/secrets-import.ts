/**
 * `agents secrets import-keyring` — migrate secrets out of the native OS
 * credential store (GNOME Keyring on Linux, Windows Credential Manager) and into
 * the encrypted file store.
 *
 * On a headless box the native store needs an interactive login to unlock, so a
 * daemon / SSH session / SessionStart hook can't read it. The file store is
 * passwordless (machine-local key), so once secrets live there they're readable
 * without a prompt forever. This command performs that one-time move so the file
 * store becomes the complete source of truth and the split-brain (native items
 * shadowed by the file store) goes away.
 *
 * macOS is not affected — it has no file fallback and uses `migrate-acl` for its
 * own item-visibility classes — so this command refuses to run there.
 *
 * Dry-run by default (mirrors `migrate-acl`); `--commit` performs the writes.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { importNativeItems } from '../lib/secrets/index.js';

/** Register `agents secrets import-keyring` on the parent secrets Command. */
export function registerSecretsImportKeyringCommand(secrets: Command): void {
  secrets
    .command('import-keyring')
    .description('Migrate secrets from the OS keyring / Credential Manager into the encrypted file store (headless-safe). Dry-run by default.')
    .option('--commit', 'Perform the import (default is dry-run reporting only)')
    .option('--prefix <p>', "Only import items beginning with PREFIX (default: all of agents-cli's items)")
    .action((opts: { commit?: boolean; prefix?: string }) => {
      try {
        if (process.platform === 'darwin') {
          throw new Error(
            'import-keyring is for the Linux/Windows headless file-store fallback. ' +
            'macOS reads the keychain directly; use `agents secrets migrate-acl` for legacy items.',
          );
        }
        const prefix = opts.prefix ?? '';
        const report = importNativeItems(prefix, !!opts.commit);

        if (!report.available) {
          console.log(chalk.gray(
            process.platform === 'win32'
              ? 'Windows Credential Manager is not reachable (no PowerShell) — nothing to import.'
              : 'No keyring tooling found (install libsecret-tools) — nothing to import.',
          ));
          return;
        }
        if (report.locked) {
          console.error(chalk.yellow(
            'The native credential store is locked/unreachable, so its secrets can\'t be read.\n' +
            'Unlock it (log in interactively / unlock the keyring), then re-run this command.',
          ));
          process.exit(1);
        }
        if (report.results.length === 0) {
          console.log(chalk.green('Nothing to import — no native secrets outside the file store.'));
          return;
        }

        const toMove = report.results.filter((r) => r.status === 'imported' || r.status === 'would-import');
        const existing = report.results.filter((r) => r.status === 'exists');
        const failed = report.results.filter((r) => r.status === 'failed');

        for (const r of report.results) {
          if (r.status === 'imported') console.log(`  ${chalk.green('imported')} ${r.item}`);
          else if (r.status === 'would-import') console.log(`  ${chalk.cyan('would import')} ${r.item}`);
          else if (r.status === 'exists') console.log(`  ${chalk.gray('exists')}   ${r.item} ${chalk.gray('(already in file store)')}`);
          else console.log(`  ${chalk.red('failed')}   ${r.item} ${chalk.gray(r.detail ?? '')}`);
        }
        console.log();

        if (!opts.commit) {
          console.log(chalk.gray(
            `Dry-run — ${toMove.length} item(s) would move` +
            `${existing.length ? `, ${existing.length} already present` : ''}. Pass --commit to migrate.`,
          ));
          return;
        }

        const moved = report.results.filter((r) => r.status === 'imported').length;
        if (failed.length > 0) {
          console.error(chalk.yellow(`Imported ${moved} item(s); ${failed.length} failed.`));
          process.exit(1);
        }
        console.log(chalk.green(`Imported ${moved} item(s) into the file store.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
