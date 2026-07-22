import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dashboard } from './Dashboard.js';

const packageRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

describe('agents-dbg Rush brand pass', () => {
  it('renders the Rush-branded dashboard with lucide SVG icons and no emoji', () => {
    const html = renderToStaticMarkup(createElement(Dashboard));

    expect(html).toContain('Rush Debug');
    expect(html).toContain('class="dbg-server-pill"');
    expect(html).toContain('class="lucide ');
    expect(html).toContain('JSON-RPC and OAuth log stream');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('keeps visible colors on Rush palette variables', () => {
    const css = readFileSync(resolve(packageRoot, 'src/index.css'), 'utf8');
    const colorToken = /#[0-9a-fA-F]{3,8}\b|rgba?\(|\btransparent\b/;
    const outsidePalette = css
      .split('\n')
      .filter(line => colorToken.test(line))
      .filter(line => !line.trim().startsWith('--rush-'))
      .filter(line => !line.includes('var(--rush-'));

    expect(outsidePalette).toEqual([]);
  });

  it('points electron-builder mac.icon at the Rush-style app icon asset', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    const iconPath = packageJson.build.mac.icon;
    const icon = readFileSync(resolve(packageRoot, iconPath), 'utf8');

    expect(iconPath).toBe('assets/agents-dbg.svg');
    expect(icon).toContain('rush-gold');
    expect(icon).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
