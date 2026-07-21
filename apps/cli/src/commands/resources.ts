/**
 * `agents resources [--merged]` — print the merged resource surface across the
 * four config layers (project > user > system > extras), each row tagged with the
 * winning layer.
 *
 * The resolution already exists in `listResources()` (lib/resources.ts): it walks
 * the ordered roots and returns a first-wins union annotated with its `source`
 * layer. This command just loops the drillable kinds and renders that union — no
 * new resolution logic. Where `agents inspect <target>` shows ONE layer/repo, this
 * shows the resolved merged union.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { listResources, type ResourceKind } from '../lib/resources.js';

/** Kinds that resolve across the four config layers, in display order. */
const MERGED_KINDS: ResourceKind[] = [
  'skills',
  'commands',
  'mcp',
  'hooks',
  'rules',
  'plugins',
  'workflows',
  'subagents',
];

/** Colour a layer tag so the winning source reads at a glance. */
function tagLayer(source: string): string {
  switch (source) {
    case 'project': return chalk.green(source);
    case 'user': return chalk.cyan(source);
    case 'system': return chalk.gray(source);
    default: return chalk.magenta(source); // extra-repo alias
  }
}

export function registerResourcesCommand(program: Command): void {
  program
    .command('resources')
    .description('Print the merged resource surface (skills/commands/mcp/hooks/rules/plugins/workflows/subagents) resolved across the four config layers — project > user > system > extras — each row tagged with the winning layer.')
    .option('--merged', 'resolve the merged union across all layers (default behaviour)')
    .option('--json', 'emit machine-readable JSON')
    .action((opts: { merged?: boolean; json?: boolean }) => {
      const surface = MERGED_KINDS.map((kind) => ({ kind, items: listResources(kind) }));

      if (opts.json) {
        const out: Record<string, { name: string; source: string; path: string }[]> = {};
        for (const { kind, items } of surface) {
          out[kind] = items.map((r) => ({ name: r.name, source: r.source, path: r.path }));
        }
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      const total = surface.reduce((n, s) => n + s.items.length, 0);
      if (total === 0) {
        console.log(chalk.gray('No resources found across project, user, system, or extra repos.'));
        return;
      }

      console.log(chalk.bold(`Merged resources (${total})`) + chalk.gray('  project > user > system > extras'));
      for (const { kind, items } of surface) {
        if (items.length === 0) continue;
        console.log('\n' + chalk.bold(kind) + chalk.gray(` (${items.length})`));
        const nameW = Math.max(...items.map((r) => r.name.length));
        for (const r of items.sort((a, b) => a.name.localeCompare(b.name))) {
          console.log(`  ${r.name.padEnd(nameW)}  ${tagLayer(r.source)}`);
        }
      }
    });
}
