import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dashboard } from './Dashboard.js';

const packageRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const forbiddenBrandCss = new RegExp([
  String.raw`--r[u]sh-`,
  'Corm' + 'orant ' + 'Gara' + 'mond',
  '#d7' + 'b56d',
  '#f8' + 'f0da',
].join('|'));
const forbiddenIcon = new RegExp([
  String.raw`r[u]sh`,
  'fal' + 'con',
  '#d7' + 'b56d',
  '#f8' + 'f0da',
].join('|'), 'i');

describe('agents-dbg Phoenix brand pass', () => {
  it('renders the terminal-coded dashboard with lucide SVG icons and no emoji', () => {
    const html = renderToStaticMarkup(createElement(Dashboard));

    expect(html).toContain('Debug Console');
    expect(html).toContain('class="dbg-server-pill"');
    expect(html).toContain('class="lucide ');
    expect(html).toContain('JSON-RPC and OAuth log stream');
    expect(html).not.toMatch(/R[u]sh Debug/);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('keeps visible colors on Phoenix terminal palette variables', () => {
    const css = readFileSync(resolve(packageRoot, 'src/index.css'), 'utf8');
    const colorToken = /#[0-9a-fA-F]{3,8}\b|rgba?\(|\btransparent\b/;
    const outsidePalette = css
      .split('\n')
      .filter(line => colorToken.test(line))
      .filter(line => !line.trim().startsWith('--agents-'))
      .filter(line => !line.includes('var(--agents-'));

    expect(outsidePalette).toEqual([]);
    expect(css).toContain('--agents-accent: #a3e635;');
    expect(css).toContain('--agents-bg: #0a0a0a;');
    expect(css).toContain('--agents-font-mono: "JetBrains Mono"');
    expect(css).not.toMatch(forbiddenBrandCss);
  });

  it('points electron-builder at the Phoenix terminal app metadata and icon asset', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    const iconPath = packageJson.build.mac.icon;
    const icon = readFileSync(resolve(packageRoot, iconPath), 'utf8');

    expect(packageJson.build.appId).toBe('dev.phoenixlabs.agents-dbg');
    expect(iconPath).toBe('assets/agents-dbg.svg');
    expect(icon).toContain('agents-accent');
    expect(icon).toContain('#a3e635');
    expect(icon).not.toMatch(forbiddenIcon);
    expect(icon).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
