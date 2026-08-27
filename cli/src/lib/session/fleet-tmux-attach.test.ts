/**
 * PHNX-3292 fleet half: first unique live tmux pane wins; dead panes and
 * answered collisions never attach. gatherRemoteAgentsJson is injected so a
 * sleeping peer cannot stall the assertion.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  attachFleetLiveSelector,
  isDefinitiveRemoteTmuxHit,
  isFleetTmuxSelector,
  parseRemoteTmuxList,
  remoteTmuxAttachScript,
  remoteTmuxNameMatchesSelector,
  type RemoteTmuxSession,
} from './fleet-tmux-attach.js';

const emptyRemote = {
  items: [] as RemoteTmuxSession[],
  deviceCount: 2,
  skipped: ['asleep-peer'],
  parseFailed: [] as string[],
  discoveryFailed: false,
};

describe('isFleetTmuxSelector', () => {
  it('accepts a live tmux alias and an exact 8-hex short id', () => {
    expect(isFleetTmuxSelector('ag-claude-0145ab8f')).toBe(true);
    expect(isFleetTmuxSelector('0145ab8f')).toBe(true);
    expect(isFleetTmuxSelector('0145AB8F')).toBe(true);
  });

  it('rejects labels, short prefixes, and full UUIDs (those are index lookups)', () => {
    expect(isFleetTmuxSelector('fix the flaky ssh test')).toBe(false);
    expect(isFleetTmuxSelector('0145ab')).toBe(false);
    expect(isFleetTmuxSelector('019fd0c8-b3e9-77a2-a1a4-444698c4d897')).toBe(false);
    expect(isFleetTmuxSelector(undefined)).toBe(false);
  });
});

describe('remoteTmuxNameMatchesSelector / isDefinitiveRemoteTmuxHit', () => {
  const live: RemoteTmuxSession = { machine: 'yosemite-s0', name: 'ag-claude-0145ab8f', live: true };
  const dead: RemoteTmuxSession = { machine: 'yosemite-s0', name: 'ag-claude-0145ab8f', live: false };

  it('matches the exact alias and the bare 8-hex suffix', () => {
    expect(remoteTmuxNameMatchesSelector(live.name, 'ag-claude-0145ab8f')).toBe(true);
    expect(remoteTmuxNameMatchesSelector(live.name, '0145ab8f')).toBe(true);
    expect(remoteTmuxNameMatchesSelector(live.name, 'ag-codex-0145ab8f')).toBe(false);
    expect(remoteTmuxNameMatchesSelector(live.name, 'deadbeef')).toBe(false);
  });

  it('a dead pane is never a definitive hit', () => {
    expect(isDefinitiveRemoteTmuxHit(dead, 'ag-claude-0145ab8f')).toBe(false);
    expect(isDefinitiveRemoteTmuxHit(live, 'ag-claude-0145ab8f')).toBe(true);
  });

  it('a missing live flag (older peer JSON) still opts in — attach re-reads pane_dead', () => {
    expect(isDefinitiveRemoteTmuxHit({ machine: 'm', name: 'ag-claude-0145ab8f' }, '0145ab8f')).toBe(true);
  });
});

describe('parseRemoteTmuxList', () => {
  it('tags rows with the dialed machine and drops non-objects', () => {
    const rows = parseRemoteTmuxList(
      JSON.stringify([
        { name: 'ag-claude-0145ab8f', socket: '/tmp/tmux.sock', live: true },
        { name: 'ag-grok-deadbeef', live: false },
        { not: 'a session' },
        'skip',
      ]),
      'yosemite-s0',
    );
    expect(rows).toEqual([
      { machine: 'yosemite-s0', name: 'ag-claude-0145ab8f', socket: '/tmp/tmux.sock', live: true },
      { machine: 'yosemite-s0', name: 'ag-grok-deadbeef', socket: undefined, live: false },
    ]);
  });

  it('returns [] on non-JSON or a non-array', () => {
    expect(parseRemoteTmuxList('not json', 'm')).toEqual([]);
    expect(parseRemoteTmuxList('{"name":"x"}', 'm')).toEqual([]);
  });
});

describe('remoteTmuxAttachScript', () => {
  it('attaches by exact session name and tears the session down if every pane is dead after', () => {
    const script = remoteTmuxAttachScript({ name: 'ag-claude-0145ab8f', socket: '/tmp/agents.sock' });
    expect(script).toContain('-S /tmp/agents.sock');
    expect(script).toContain('attach-session -t =ag-claude-0145ab8f');
    expect(script).toContain('kill-session');
  });
});

describe('attachFleetLiveSelector', () => {
  it('--local never dials', async () => {
    const gather = vi.fn(async () => emptyRemote);
    expect(await attachFleetLiveSelector('ag-claude-0145ab8f', { local: true }, { gather: gather as never })).toBe(false);
    expect(gather).not.toHaveBeenCalled();
  });

  it('a unique live hit attaches immediately, quiet, with earlyExit, and scopes --device', async () => {
    const hit: RemoteTmuxSession = { machine: 'yosemite-s0', name: 'ag-claude-0145ab8f', live: true };
    const gather = vi.fn(async () => ({ ...emptyRemote, items: [hit], skipped: [] }));
    const attach = vi.fn(async () => {});
    const attached = await attachFleetLiveSelector(
      'ag-claude-0145ab8f',
      { hosts: ['yosemite-s0'] },
      { gather: gather as never, attach },
    );
    expect(attached).toBe(true);
    expect(attach).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledWith(hit);
    expect(gather).toHaveBeenCalledOnce();
    const opts = gather.mock.calls[0]?.[0] as {
      args: string[];
      hosts?: string[];
      quiet?: boolean;
      earlyExit?: { isDefinitive: (item: RemoteTmuxSession) => boolean };
    };
    expect(opts.args).toEqual(['tmux', 'list', '--json']);
    expect(opts.hosts).toEqual(['yosemite-s0']);
    expect(opts.quiet).toBe(true);
    expect(opts.earlyExit?.isDefinitive(hit)).toBe(true);
    expect(opts.earlyExit?.isDefinitive({ ...hit, live: false })).toBe(false);
  });

  it('a unique 8-hex hit on one live alias attaches that alias', async () => {
    const hit: RemoteTmuxSession = { machine: 'yosemite-s0', name: 'ag-grok-d040b10e', live: true };
    const attach = vi.fn(async () => {});
    const attached = await attachFleetLiveSelector(
      'd040b10e',
      {},
      { gather: (async () => ({ ...emptyRemote, items: [hit] })) as never, attach },
    );
    expect(attached).toBe(true);
    expect(attach).toHaveBeenCalledWith(hit);
  });

  it('two answered live panes sharing the selector fail closed with both device:name', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prior = process.exitCode;
    process.exitCode = undefined;
    const attach = vi.fn(async () => {});
    try {
      const attached = await attachFleetLiveSelector(
        '0145ab8f',
        {},
        {
          gather: (async () => ({
            ...emptyRemote,
            items: [
              { machine: 'yosemite-s0', name: 'ag-claude-0145ab8f', live: true },
              { machine: 'winbox', name: 'ag-codex-0145ab8f', live: true },
            ],
          })) as never,
          attach,
        },
      );
      expect(attached).toBe(true);
      expect(attach).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(err.mock.calls.flat().join('\n')).toMatch(/yosemite-s0:ag-claude-0145ab8f/);
      expect(err.mock.calls.flat().join('\n')).toMatch(/winbox:ag-codex-0145ab8f/);
    } finally {
      err.mockRestore();
      process.exitCode = prior;
    }
  });

  it('a dead pane on the only answering peer is a miss, not an attach', async () => {
    const attach = vi.fn(async () => {});
    const attached = await attachFleetLiveSelector(
      'ag-claude-0145ab8f',
      {},
      {
        gather: (async () => ({
          ...emptyRemote,
          items: [{ machine: 'yosemite-s0', name: 'ag-claude-0145ab8f', live: false }],
        })) as never,
        attach,
      },
    );
    expect(attached).toBe(false);
    expect(attach).not.toHaveBeenCalled();
  });

  it('a genuine miss returns false so the caller can fall through to index resume', async () => {
    const attach = vi.fn(async () => {});
    expect(await attachFleetLiveSelector('ag-claude-ffffffff', {}, {
      gather: (async () => emptyRemote) as never,
      attach,
    })).toBe(false);
    expect(attach).not.toHaveBeenCalled();
  });
});
