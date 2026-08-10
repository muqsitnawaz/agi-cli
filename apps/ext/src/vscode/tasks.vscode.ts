// VS Code integration for unified task management
// Aggregates tasks from Linear + GitHub.

import * as vscode from 'vscode';
import { TaskSource, TaskSourceSettings } from '../core/settings';
import { UnifiedTask, CycleInfo, buildTicketsListArgs, groupTasksBySource } from '../core/tasks';
import { runAgentsArgs } from '../core/agentsBin';

export interface TaskFetchResult {
  tasks: UnifiedTask[];
  cycleInfo: CycleInfo | null;
}

interface TicketsListResult {
  tickets: UnifiedTask[];
  cycleInfo: CycleInfo | null;
  sources: {
    linear: { available: boolean; error?: string };
    github: { available: boolean; error?: string };
  };
}

async function listTickets(enabled: TaskSourceSettings, cwd?: string): Promise<TicketsListResult> {
  const { stdout } = await runAgentsArgs(buildTicketsListArgs(enabled, cwd));
  const parsed = JSON.parse(stdout) as TicketsListResult;
  if (!Array.isArray(parsed.tickets) || !parsed.sources) {
    throw new Error('agents tickets list --json returned an unsupported payload; upgrade agents-cli');
  }
  return parsed;
}

// Detect which task sources are available based on MCP configuration
export async function detectAvailableSources(context: vscode.ExtensionContext): Promise<{
  linear: boolean;
  github: boolean;
}> {
  void context;
  const result = await listTickets({ linear: true, github: true, githubAssignedOnly: false });
  return { linear: result.sources.linear.available, github: result.sources.github.available };
}

// Fetch tasks from each source that is both (a) available (CLI installed)
// and (b) enabled by the user in settings.
export async function fetchAllTasks(
  context: vscode.ExtensionContext,
  enabledSources: TaskSourceSettings
): Promise<TaskFetchResult> {
  void context;
  const result = await listTickets(enabledSources, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  return { tasks: result.tickets, cycleInfo: result.cycleInfo };
}

// Get tasks grouped by source for UI display
export async function fetchTasksGrouped(
  context: vscode.ExtensionContext,
  enabledSources: TaskSourceSettings
): Promise<Map<TaskSource, UnifiedTask[]>> {
  const { tasks } = await fetchAllTasks(context, enabledSources);
  return groupTasksBySource(tasks);
}
