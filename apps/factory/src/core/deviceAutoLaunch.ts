import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AutoLaunchPreference {
  enabled?: boolean;
  preferred?: boolean;
}

export interface AutoLaunchPreferences {
  devices: Record<string, AutoLaunchPreference>;
  updatedAt?: string;
}

function autoLaunchPath(): string {
  return path.join(os.homedir(), '.agents', '.history', 'devices', 'auto-launch.json');
}

/**
 * Load auto-launch preferences written by `agents devices enable/disable/prefer`.
 * Missing or malformed file => empty map. Synchronous because callers need it
 * during ranking without awaiting another turn.
 */
export function loadAutoLaunchPreferences(): Record<string, AutoLaunchPreference> {
  try {
    const raw = fs.readFileSync(autoLaunchPath(), 'utf-8');
    const parsed = JSON.parse(raw) as AutoLaunchPreferences;
    return parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    console.error('[deviceAutoLaunch] failed to load preferences:', err?.message ?? err);
    return {};
  }
}

/** True if the device is enabled for auto-launch. Defaults to true. */
export function isAutoLaunchEnabled(
  preferences: Record<string, AutoLaunchPreference>,
  name: string,
): boolean {
  return preferences[name]?.enabled !== false;
}

/** True if the device is preferred for auto-launch ranking. */
export function isAutoLaunchPreferred(
  preferences: Record<string, AutoLaunchPreference>,
  name: string,
): boolean {
  return preferences[name]?.preferred === true;
}
