import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { publishBlock, listBlocks, removeBlock, blockIdForSession, type OpenBlock } from './feed.js';

function tmpFeedDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-test-'));
}

function makeBlock(sessionId: string, text: string, opts?: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: blockIdForSession(sessionId),
    sessionId,
    mailboxId: sessionId,
    host: 'test-host',
    runtime: 'claude',
    ts: new Date().toISOString(),
    question: { text },
    ...opts,
  };
}

describe('feed store', () => {
  it('publishes a block and reads it back', () => {
    const dir = tmpFeedDir();
    const block = makeBlock('sess-1', 'Which approach?', {
      question: {
        text: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
        multiSelect: false,
      },
    });
    publishBlock(block, dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockId).toBe('block-sess-1');
    expect(blocks[0].sessionId).toBe('sess-1');
    expect(blocks[0].question.text).toBe('Which approach?');
    expect(blocks[0].question.options).toHaveLength(2);
    expect(blocks[0].question.options![0].label).toBe('A');
  });

  it('replaces a block when the same session publishes again', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-2', 'first question'), dir);
    publishBlock(makeBlock('sess-2', 'second question'), dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].question.text).toBe('second question');
  });

  it('lists multiple blocks from different sessions', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('aaa', 'question A'), dir);
    publishBlock(makeBlock('bbb', 'question B'), dir);
    publishBlock(makeBlock('ccc', 'question C'), dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(3);
    expect(blocks.map(b => b.sessionId)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('removes a block by id', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('to-remove', 'remove me'), dir);
    expect(listBlocks(dir)).toHaveLength(1);

    const removed = removeBlock(blockIdForSession('to-remove'), dir);
    expect(removed).toBe(true);
    expect(listBlocks(dir)).toHaveLength(0);
  });

  it('removeBlock returns false for a missing block', () => {
    const dir = tmpFeedDir();
    expect(removeBlock('no-such-block', dir)).toBe(false);
  });

  it('listBlocks returns empty for a missing directory', () => {
    expect(listBlocks('/tmp/nonexistent-feed-dir-' + Date.now())).toEqual([]);
  });

  it('skips corrupt JSON files', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('valid', 'a real question'), dir);
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{not valid json', 'utf-8');
    fs.writeFileSync(path.join(dir, 'empty.json'), '{}', 'utf-8');

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sessionId).toBe('valid');
  });

  it('publish is atomic (no partial reads)', () => {
    const dir = tmpFeedDir();
    const block = makeBlock('atomic', 'atomic write test');
    publishBlock(block, dir);

    const files = fs.readdirSync(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    expect(files.filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('blockIdForSession produces a deterministic id', () => {
    expect(blockIdForSession('abc-123')).toBe('block-abc-123');
    expect(blockIdForSession('abc-123')).toBe(blockIdForSession('abc-123'));
  });

  it('preserves ticket and PR fields', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('with-meta', 'question', {
      ticket: 'RUSH-1473',
      pr: 'https://github.com/phnx-labs/agents-cli/pull/999',
    }), dir);

    const blocks = listBlocks(dir);
    expect(blocks[0].ticket).toBe('RUSH-1473');
    expect(blocks[0].pr).toBe('https://github.com/phnx-labs/agents-cli/pull/999');
  });
});
