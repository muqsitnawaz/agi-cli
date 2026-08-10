import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TaskSource, TaskSourceSettings } from '../core/settings';
import { UnifiedTask, CycleInfo, groupTasksBySource } from '../core/tasks';
import { bootstrapPath, resolveAgentsBin } from '../core/agentsBin';

const execFileAsync = promisify(execFile);

interface CliTaskResult {
  tasks: UnifiedTask[];
  cycleInfo: CycleInfo | null;
  sources: { linear: boolean; github: boolean };
}

async function fetchCliTasks(enabledSources: TaskSourceSettings): Promise<CliTaskResult> {
  const bin = await resolveAgentsBin();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const args = ['factory', 'tasks', '--json', '--cwd', cwd];
  if (!enabledSources.linear) args.push('--no-linear');
  if (!enabledSources.github) args.push('--no-github');
  if (enabledSources.githubAssignedOnly) args.push('--github-assigned-only');
  const { stdout } = await execFileAsync(bin, args, {
    timeout: 20_000,
    env: { ...process.env, PATH: `${bootstrapPath(bin)}:${process.env.PATH ?? ''}` },
  });
  return JSON.parse(stdout) as CliTaskResult;
}

export async function detectAvailableSources(_context: vscode.ExtensionContext): Promise<{ linear: boolean; github: boolean }> {
  return (await fetchCliTasks({ linear: true, github: true, githubAssignedOnly: false })).sources;
}

export async function fetchAllTasks(_context: vscode.ExtensionContext, enabledSources: TaskSourceSettings): Promise<{ tasks: UnifiedTask[]; cycleInfo: CycleInfo | null }> {
  const result = await fetchCliTasks(enabledSources);
  return { tasks: result.tasks, cycleInfo: result.cycleInfo };
}

export async function fetchTasksGrouped(context: vscode.ExtensionContext, enabledSources: TaskSourceSettings): Promise<Map<TaskSource, UnifiedTask[]>> {
  const { tasks } = await fetchAllTasks(context, enabledSources);
  return groupTasksBySource(tasks);
}
