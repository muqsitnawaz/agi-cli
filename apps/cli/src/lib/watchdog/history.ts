import type { WatchdogEvent, WatchdogEventKind } from './log.js';

export interface WatchdogHistoryEntry {
  ts: number;
  kind: WatchdogEventKind;
  sessionId?: string;
  agent?: string;
  message: string;
  reason?: string;
  stalledForMs?: number;
  nudgeText?: string;
}

export interface WatchdogHistoryOptions {
  limit?: number;
  sinceMs?: number;
  sessionId?: string;
  includeTicks?: boolean;
  nowMs?: number;
}

/** Select newest history and deliberately remove raw transcript tailLines. */
export function selectWatchdogHistory(
  events: WatchdogEvent[],
  options: WatchdogHistoryOptions = {},
): WatchdogHistoryEntry[] {
  const limit = options.limit ?? 50;
  const cutoff = options.sinceMs === undefined
    ? Number.NEGATIVE_INFINITY
    : (options.nowMs ?? Date.now()) - options.sinceMs;
  const session = options.sessionId?.toLowerCase();

  return events
    .filter((event) => options.includeTicks || event.kind !== 'tick')
    .filter((event) => event.ts >= cutoff)
    .filter((event) => !session || event.terminalId?.toLowerCase().startsWith(session))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((event) => ({
      ts: event.ts,
      kind: event.kind,
      sessionId: event.terminalId,
      agent: event.agentType,
      message: event.message,
      reason: event.reason,
      stalledForMs: event.stalledForMs,
      nudgeText: event.nudgeText,
    }));
}
