// Pure types for unified task management across multiple sources
// No VS Code dependencies - testable

// UnifiedTask / TaskMetadata / TaskComment / TaskSource are canonical in
// src/shared/tasks.ts — the ONE definition shared with the webview (@shared), so a
// field (e.g. `project`) can never be present on one side of the postMessage
// boundary and missing on the other. Imported for local use here + re-exported for
// existing consumers.
import type { TaskSource, UnifiedTask, TaskMetadata, TaskComment } from '../shared/tasks';
export type { UnifiedTask, TaskMetadata, TaskComment, TaskSource };

export interface TaskDispatchPromptInput {
  title: string;
  description?: string;
  identifier?: string;
  url?: string;
  extraComments?: string;
}

function cleanPromptPart(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function buildTaskDispatchPrompt(input: TaskDispatchPromptInput): string {
  const parts: string[] = [];
  const title = cleanPromptPart(input.title);
  const description = cleanPromptPart(input.description);
  const identifier = cleanPromptPart(input.identifier);
  const url = cleanPromptPart(input.url);
  const extraComments = cleanPromptPart(input.extraComments);

  if (title) parts.push(title);
  if (description) parts.push(description);
  if (identifier) parts.push(`Reference: ${identifier}`);
  if (url) parts.push(`URL: ${url}`);
  if (extraComments) parts.push(`Additional instructions:\n${extraComments}`);

  return parts.join('\n\n');
}

// Extract the first repo:<name> label value. Pure — does not resolve owner.
// Callers combine with an owner (resolved in the VS Code layer) to form owner/repo.
export function extractRepoNameFromLabels(labels: string[] | undefined): string | null {
  if (!labels) return null;
  for (const raw of labels) {
    if (typeof raw !== 'string') continue;
    const m = raw.trim().match(/^repo:([A-Za-z0-9._-]+)$/);
    if (m) return m[1];
  }
  return null;
}

// Active cycle info from Linear
export interface CycleInfo {
  name: string;
  startsAt: string;              // ISO 8601
  endsAt: string;                // ISO 8601
}

// Source badge display info
export const SOURCE_BADGES: Record<TaskSource, { label: string; color: string }> = {
  linear: { label: 'LN', color: '#5e6ad2' },    // Linear purple
  github: { label: 'GH', color: '#238636' }     // GitHub green
};

// Group tasks by source
export function groupTasksBySource(tasks: UnifiedTask[]): Map<TaskSource, UnifiedTask[]> {
  const groups = new Map<TaskSource, UnifiedTask[]>();
  for (const task of tasks) {
    const existing = groups.get(task.source) || [];
    existing.push(task);
    groups.set(task.source, existing);
  }
  return groups;
}

// Filter tasks by status
export function filterTasksByStatus(
  tasks: UnifiedTask[],
  statuses: UnifiedTask['status'][]
): UnifiedTask[] {
  return tasks.filter(t => statuses.includes(t.status));
}
