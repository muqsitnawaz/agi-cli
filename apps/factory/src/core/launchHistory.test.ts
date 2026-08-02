import { describe, expect, test } from 'bun:test';
import {
  LAUNCH_HEALTH_MAX_AGE_MS,
  LaunchHealthCache,
  pickCachedLaunchHost,
  recordLaunch,
} from './launchHistory';

const NOW = 1_800_000_000_000;

function cache(devices: LaunchHealthCache['devices']): LaunchHealthCache {
  return { devices, refreshedAt: NOW };
}

describe('pickCachedLaunchHost', () => {
  test('combines successful recent history with cached machine health', () => {
    const health = cache([
      { name: 'familiar', online: true, sshReachable: true, running: 1, loadAvg1: 1, memPercent: 20, usableAgents: { codex: true }, fetchedAt: NOW },
      { name: 'unused', online: true, sshReachable: true, running: 0, loadAvg1: 1, memPercent: 20, usableAgents: { codex: true }, fetchedAt: NOW },
    ]);
    const history = {
      familiar: { launches: 12, successes: 12, lastLaunchAt: NOW - 60_000 },
    };

    expect(pickCachedLaunchHost('codex', health, history, NOW)).toBe('familiar');
  });

  test('never selects offline, SSH-unreachable, or harness-unusable devices', () => {
    const health = cache([
      { name: 'offline', online: false, sshReachable: true, running: 0, usableAgents: { claude: true }, fetchedAt: NOW },
      { name: 'ssh-down', online: true, sshReachable: false, running: 0, usableAgents: { claude: true }, fetchedAt: NOW },
      { name: 'signed-out', online: true, sshReachable: true, running: 0, usableAgents: { claude: false }, fetchedAt: NOW },
      { name: 'ready', online: true, sshReachable: true, running: 3, usableAgents: { claude: true }, fetchedAt: NOW },
    ]);

    expect(pickCachedLaunchHost('claude', health, {}, NOW)).toBe('ready');
  });

  test('cold or stale cache returns null for local fallback', () => {
    expect(pickCachedLaunchHost('gemini', undefined, {}, NOW)).toBeNull();
    const stale = cache([]);
    stale.refreshedAt = NOW - LAUNCH_HEALTH_MAX_AGE_MS - 1;
    expect(pickCachedLaunchHost('gemini', stale, {}, NOW)).toBeNull();
  });
});

test('recordLaunch preserves per-device frequency, recency, and success', () => {
  const first = recordLaunch({}, 'Yosemite-S0', true, NOW - 10);
  const second = recordLaunch(first, 'yosemite-s0', false, NOW);
  expect(second['yosemite-s0']).toEqual({ launches: 2, successes: 1, lastLaunchAt: NOW });
});
