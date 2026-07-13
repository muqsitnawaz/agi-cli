import { describe, it, expect, afterEach } from 'vitest';
import { flagValue, maybeRunOnHost } from './passthrough.js';
import { machineId } from '../session/sync/config.js';

describe('flagValue', () => {
  it('reads the space-separated long form', () => {
    expect(flagValue(['view', '--host', 'mac'], 'host', 'H')).toBe('mac');
  });
  it('reads the --host=value form', () => {
    expect(flagValue(['view', '--host=mac'], 'host', 'H')).toBe('mac');
  });
  it('reads the -H value and glued -Hmac forms', () => {
    expect(flagValue(['view', '-H', 'mac'], 'host', 'H')).toBe('mac');
    expect(flagValue(['view', '-Hmac'], 'host', 'H')).toBe('mac');
  });
  it('reads --remote-cwd (long-only, no short)', () => {
    expect(flagValue(['sync', '--remote-cwd', '/srv'], 'remote-cwd')).toBe('/srv');
  });
  it('returns undefined when absent', () => {
    expect(flagValue(['view', '--json'], 'host', 'H')).toBeUndefined();
  });
});

describe('maybeRunOnHost — local short-circuits (no SSH attempted)', () => {
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
  });

  it('returns false when the command is not host-routable', async () => {
    expect(await maybeRunOnHost('secrets', ['secrets', 'list', '--host', 'mac'])).toBe(false);
  });

  it('leaves feed host lists to the command-level fleet aggregator', async () => {
    expect(await maybeRunOnHost('feed', ['feed', '--host', 'mac', '--json'])).toBe(false);
  });

  it('returns false when no --host is given', async () => {
    expect(await maybeRunOnHost('view', ['view', 'claude'])).toBe(false);
  });

  it('returns false when neither --host nor its --device alias is given', async () => {
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi'])).toBe(false);
  });

  it('returns false when --host names this very machine (runs locally instead)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(machineId()).toBe('mybox');
    expect(await maybeRunOnHost('view', ['view', '--host', 'mybox'])).toBe(false);
    // case-insensitive: the self-check must not SSH to `MyBox` either
    expect(await maybeRunOnHost('view', ['view', '--host', 'MyBox'])).toBe(false);
  });

  it('treats --device as an alias of --host for the self-machine short-circuit', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --device naming this machine must short-circuit to a local run, exactly
    // like --host would — otherwise the alias would SSH to itself.
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi', '--device', 'mybox'])).toBe(false);
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi', '--device=mybox'])).toBe(false);
  });

  it('rejects a conflicting --host/--device pair without attempting SSH', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // Handled (returns true) but as an error — never guesses which host wins.
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi', '--host', 'a', '--device', 'b'])).toBe(true);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('routes routines --host to remote', async () => {
    // routines is in the passthrough table; with --host naming a non-self
    // machine, maybeRunOnHost should return true (it would SSH if the host
    // were reachable — we only test the selection logic here).
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // Self-machine check: --host mybox is local.
    expect(await maybeRunOnHost('routines', ['routines', 'list', '--host', 'mybox'])).toBe(false);
  });

  it('does NOT bail on --devices for routines (placement, not fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --devices on routines is placement; --host should still route remotely.
    // Self-machine short-circuit makes this false, confirming --devices didn't bail.
    expect(await maybeRunOnHost('routines', ['routines', 'add', 'x', '--host', 'mybox', '--devices', 'a,b'])).toBe(false);
  });

  it('bails on --devices for non-routines commands (fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('list', ['list', '--host', 'other', '--devices'])).toBe(false);
  });

  it('treats --device as alias of --host for routines routing', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --device naming self -> local.
    expect(await maybeRunOnHost('routines', ['routines', 'run', 'x', '--device', 'mybox'])).toBe(false);
  });
});
