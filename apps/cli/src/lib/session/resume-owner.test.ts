/**
 * RUSH-2022 — a session that ran on another device must never resume here.
 *
 * Real path, no mocks: `sessionOwnerDevice` / `resumeDestinationMismatch` read
 * the same `machineId()` and `isSelfHost()` this machine answers with, and the
 * tests drive them through `AGENTS_SYNC_MACHINE_ID` (the documented override in
 * lib/machine-id.ts) rather than stubbing either function.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sessionOwnerDevice, resumeDestinationMismatch } from './resume-owner.js';
import { resetSelfHostCache } from '../devices/self-host.js';

const SELF = 'test-owner-box';

beforeEach(() => {
  process.env.AGENTS_SYNC_MACHINE_ID = SELF;
  resetSelfHostCache();
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  resetSelfHostCache();
});

describe('sessionOwnerDevice', () => {
  it('names the peer for a session whose transcript originated elsewhere', () => {
    // The exact shape of a synced mirror row: machine-tagged, readable here.
    expect(sessionOwnerDevice({ machine: 'zion' })).toBe('zion');
  });

  it('is case- and domain-insensitive about this machine', () => {
    expect(sessionOwnerDevice({ machine: SELF })).toBeUndefined();
    expect(sessionOwnerDevice({ machine: SELF.toUpperCase() })).toBeUndefined();
  });

  it('leaves an untagged row alone rather than inventing a target', () => {
    expect(sessionOwnerDevice({})).toBeUndefined();
    expect(sessionOwnerDevice({ machine: '' })).toBeUndefined();
    expect(sessionOwnerDevice({ machine: '   ' })).toBeUndefined();
  });
});

describe('resumeDestinationMismatch', () => {
  it('flags a peer-owned session in a LOCAL batch — the silent wrong-machine resume', () => {
    expect(resumeDestinationMismatch({ machine: 'zion' }, undefined)).toBe('zion');
  });

  it('accepts a locally-owned session in a local batch', () => {
    expect(resumeDestinationMismatch({ machine: SELF }, undefined)).toBeUndefined();
  });

  it('accepts a session whose owner IS the --host destination', () => {
    expect(resumeDestinationMismatch({ machine: 'zion' }, 'zion')).toBeUndefined();
    expect(resumeDestinationMismatch({ machine: 'zion' }, 'ZION')).toBeUndefined();
    // The registry compares the first label only, so a tailnet dnsName matches.
    expect(resumeDestinationMismatch({ machine: 'zion' }, 'zion.tailnet.ts.net')).toBeUndefined();
  });

  it('does NOT flag a locally-owned session sent to a --host elsewhere (the /fork handoff)', () => {
    // `agents sessions fork` copies the transcript HERE, then the fork command
    // opens it on the machine the user is sitting at. That destination is
    // explicit and user-named — the opposite of the silent wrong-machine start
    // this guard exists to stop.
    expect(resumeDestinationMismatch({ machine: SELF }, 'zion')).toBeUndefined();
  });

  it('flags a peer-owned session sent to a DIFFERENT peer', () => {
    expect(resumeDestinationMismatch({ machine: 'zion' }, 'mac-mini')).toBe('zion');
  });

  it('leaves an untagged row alone at any destination', () => {
    expect(resumeDestinationMismatch({}, 'zion')).toBeUndefined();
    expect(resumeDestinationMismatch({}, undefined)).toBeUndefined();
  });
});
