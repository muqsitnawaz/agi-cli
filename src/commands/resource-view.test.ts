import { describe, expect, it } from 'vitest';
import {
  buildResourceTableLines,
  type ResourceViewOptions,
} from './resource-view.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

function resourceOptions(): ResourceViewOptions {
  return {
    resourcePlural: 'plugins',
    resourceSingular: 'plugin',
    extraLabel: 'Version',
    extra2Label: 'Marketplace',
    emptyMessage: 'No plugins.',
    rows: [
      {
        name: 'extremely-long-plugin-name-for-terminal-layout',
        description: 'A compact summary that continues past forty characters so wide terminals use the room.',
        extra: 'v2026.06.13-canary-build',
        extra2: 'internal-marketplace-with-very-long-name',
        targets: [
          { agent: 'codex', version: '0.134.0', status: 'synced' },
          { agent: 'claude', version: '2.1.112', status: 'missing' },
          { agent: 'gemini', version: '0.29.5', status: 'missing' },
        ],
        buildDetail: () => '',
      },
    ],
  };
}

describe('buildResourceTableLines', () => {
  it('keeps table lines within a narrow terminal width', () => {
    const lines = buildResourceTableLines(resourceOptions(), 64);

    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(64);
    }
    expect(stripAnsi(lines[2])).toContain('…');
  });

  it('uses wider terminals for longer descriptions', () => {
    const lines = buildResourceTableLines(resourceOptions(), 140);
    const row = stripAnsi(lines[2]);

    expect(visibleWidth(row)).toBeLessThanOrEqual(140);
    expect(row).toContain('continues past forty characters');
  });
});
