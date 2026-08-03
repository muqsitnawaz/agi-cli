import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A palette entry and its `registerCommand` are two halves of one contract, in two
 * files that nothing else keeps in step. Contribute without registering and the
 * command is in the palette but throws "command not found" on pick; register
 * without contributing and it is unreachable. Read both real files and pin them
 * to each other.
 */
const factoryRoot = path.resolve(import.meta.dir, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(factoryRoot, 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(factoryRoot, 'src/vscode/extension.ts'), 'utf8');

const contributed = (id: string) =>
  (manifest.contributes.commands as Array<{ command: string; title: string }>).find(c => c.command === id);

describe('fork command contributions', () => {
  test('Agents: Fork keeps its command id — a rename must not orphan keybindings or callers', () => {
    expect(contributed('agents.forkCurrentSession')?.title).toBe('Agents: Fork');
    expect(extensionSource).toContain("registerCommand('agents.forkCurrentSession'");
  });

  test('Agents: Fork (Pick Session) is both contributed and registered', () => {
    expect(contributed('agents.forkPickSession')?.title).toBe('Agents: Fork (Pick Session)');
    expect(extensionSource).toContain("registerCommand('agents.forkPickSession'");
  });

  test('Agents: Fork (Pick Host) is both contributed and registered', () => {
    expect(contributed('agents.forkPickHost')?.title).toBe('Agents: Fork (Pick Host)');
    expect(extensionSource).toContain("registerCommand('agents.forkPickHost'");
  });

  test('the host pick routes into the same fork, only with a device step', () => {
    // The whole promise of the command is "same fork, different machine". Two
    // entry points into two implementations would drift apart silently.
    expect(extensionSource).toContain("registerCommand('agents.forkPickHost', () => forkCurrentSession(context, { pickHost: true }))");
  });

  test('a forked tab opens beside its parent, not on top of it', () => {
    const fork = extensionSource.slice(
      extensionSource.indexOf('async function forkCurrentSession('),
      extensionSource.indexOf('function showForkRejection('),
    );
    expect(fork).toContain('viewColumn: vscode.ViewColumn.Beside');
  });
});
