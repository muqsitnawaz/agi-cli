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

  it('routes routines --host to a non-self target (enters SSH path)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // A non-self host enters the SSH resolve + sshStream path. sshStream
    // returns 255 for unreachable hosts. Returning true proves the routing
    // path was entered, not short-circuited.
    const result = await maybeRunOnHost('routines', ['routines', 'list', '--host', 'other-box']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('routes routines --device alias to a non-self target', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    const result = await maybeRunOnHost('routines', ['routines', 'run', 'x', '--device', 'other-box']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('does NOT bail on --devices for routines with --host (placement, not fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --devices on routines is placement; --host should still route remotely.
    // A non-self target enters the SSH path (returns true), proving --devices
    // did not bail.
    const result = await maybeRunOnHost('routines', ['routines', 'add', 'x', '--host', 'other-box', '--devices', 'a,b']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('bails on --devices for non-routines commands (fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --devices on a non-routines command triggers the fleet-flag bailout,
    // returning false even with a non-self --host.
    expect(await maybeRunOnHost('list', ['list', '--host', 'other-box', '--devices'])).toBe(false);
  });

  it('bails on --hosts for non-routines commands (fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('list', ['list', '--host', 'other-box', '--hosts'])).toBe(false);
  });
});
