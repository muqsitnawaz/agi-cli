/**
 * The session preview header surfaces the worked-on ticket and the PR the
 * session opened, so a reviewer can jump straight to Linear / GitHub from the
 * browser. Both are rendered by `buildPreview` (via `formatHeader`); we assert
 * the labels appear rather than the OSC 8 escape, which is TTY-gated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { buildPreview } from './sessions-picker.js';
import { _resetLinearWorkspaceCache } from '../lib/session/linear.js';
import type { SessionMeta } from '../lib/session/types.js';

function mk(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: 'link-test-' + Math.random().toString(36).slice(2),
    shortId: 'linktest',
    agent: 'claude',
    // No filePath → buildPreview takes the metadata-only branch, which still
    // renders the header (and thus the ticket/PR line) without parsing a file.
    ...overrides,
  } as SessionMeta;
}

describe('buildPreview — ticket + PR links line', () => {
  const savedEnv = process.env.LINEAR_WORKSPACE;
  beforeEach(() => {
    _resetLinearWorkspaceCache();
    process.env.LINEAR_WORKSPACE = 'acme';
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LINEAR_WORKSPACE;
    else process.env.LINEAR_WORKSPACE = savedEnv;
    _resetLinearWorkspaceCache();
  });

  it('shows the ticket id and PR number in the preview', () => {
    const preview = stripVTControlCharacters(
      buildPreview(mk({ ticketId: 'RUSH-1864', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 })),
    );
    expect(preview).toContain('RUSH-1864');
    expect(preview).toContain('PR#42');
  });

  it('embeds the canonical Linear + GitHub URLs as OSC 8 hyperlink targets when linkable', () => {
    // The raw preview (escapes intact) should carry the hyperlink targets IF the
    // terminal supports OSC 8. In a non-TTY test env it degrades to plain text, so
    // we only assert the target is present when an escape was actually emitted.
    const raw = buildPreview(
      mk({ ticketId: 'RUSH-1864', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 }),
    );
    if (raw.includes('\x1b]8;;')) {
      expect(raw).toContain('https://linear.app/acme/issue/RUSH-1864');
      expect(raw).toContain('https://github.com/o/r/pull/42');
    } else {
      expect(stripVTControlCharacters(raw)).toContain('RUSH-1864');
    }
  });

  it('omits the links line entirely when the session has neither', () => {
    const preview = stripVTControlCharacters(buildPreview(mk({})));
    expect(preview).not.toContain('PR#');
    expect(preview).not.toContain('issue/');
  });
});

describe('buildPreview — rich metadata', () => {
  it('shows compact model, tool tags, and sub-agent count from the transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-preview-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'user', timestamp: '2024-05-01T14:00:00.000Z', cwd: dir, sessionId: 'rich-meta-session', version: '2.1.112', message: { role: 'user', content: 'Build auth' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2024-05-01T14:00:10.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { prompt: 'Explore' } }] } }),
        JSON.stringify({ type: 'assistant', timestamp: '2024-05-01T14:00:12.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'agents browser list' } }] } }),
      ].join('\n') + '\n');

      const preview = stripVTControlCharacters(buildPreview(mk({
        id: 'rich-meta-session',
        shortId: 'richmeta',
        filePath,
        cwd: dir,
        topic: 'Auto title',
        label: 'User label',
      })));
      expect(preview).toContain('sonnet-4');
      expect(preview).toContain('Label: User label');
      expect(preview).toContain('Topic: Auto title');
      expect(preview).toContain('browser');
      expect(preview).toContain('shell');
      expect(preview).toContain('1 sub-agent');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
