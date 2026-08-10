import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type TicketSource = 'linear' | 'github';

export interface TicketComment {
  body: string;
  createdAt?: string;
  author?: string;
}

export interface TicketRow {
  id: string;
  source: TicketSource;
  title: string;
  description?: string;
  status: 'todo' | 'in_progress' | 'done';
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  metadata: {
    identifier?: string;
    url?: string;
    labels?: string[];
    assignee?: string;
    assigneeKind?: 'user' | 'agent';
    state?: string;
    createdAt?: string;
    dueDate?: string;
    project?: string;
    repo?: string;
    comments?: TicketComment[];
    images?: string[];
  };
}

export interface TicketListResult {
  tickets: TicketRow[];
  cycleInfo: { name: string; startsAt: string; endsAt: string } | null;
  sources: {
    linear: { available: boolean; error?: string };
    github: { available: boolean; error?: string };
  };
}

export interface TicketListOptions {
  cwd: string;
  linear: boolean;
  github: boolean;
  githubAssignedOnly: boolean;
}

const AGENT_ASSIGNEE = /^(claude|codex|gemini|cursor|opencode|antigravity|grok|kimi|droid)$/i;

function assigneeKind(name: string | undefined): 'user' | 'agent' | undefined {
  if (!name) return undefined;
  return AGENT_ASSIGNEE.test(name.trim()) ? 'agent' : 'user';
}

function imageUrls(...bodies: unknown[]): string[] | undefined {
  const urls = new Set<string>();
  const pattern = /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)|<img\b[^>]*?\bsrc\s*=\s*["'](https?:\/\/[^"']+)/gi;
  for (const body of bodies) {
    if (typeof body !== 'string') continue;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body))) urls.add(match[1] || match[2]);
  }
  return urls.size > 0 ? [...urls] : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readLinear(cwd: string): Promise<{
  tickets: TicketRow[];
  cycleInfo: TicketListResult['cycleInfo'];
}> {
  const { stdout } = await run('linear', ['tasks', '--json'], {
    cwd,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const data = JSON.parse(stdout) as any;
  const cycle = data?.cycle;
  const cycleInfo = cycle?.startsAt && cycle?.endsAt
    ? { name: String(cycle.name ?? ''), startsAt: String(cycle.startsAt), endsAt: String(cycle.endsAt) }
    : null;
  const priority: Record<number, TicketRow['priority']> = {
    1: 'urgent',
    2: 'high',
    3: 'medium',
    4: 'low',
  };

  const tickets = (Array.isArray(data?.issues) ? data.issues : []).map((issue: any): TicketRow => {
    const labels = (issue.labels?.nodes ?? []).map((label: any) => String(label.name));
    const comments: TicketComment[] = (issue.comments?.nodes ?? []).map((comment: any) => ({
      body: String(comment.body ?? ''),
      createdAt: comment.createdAt ? String(comment.createdAt) : undefined,
      author: comment.user?.name ? String(comment.user.name) : undefined,
    }));
    const stateType = String(issue.state?.type ?? '');
    const status: TicketRow['status'] = stateType === 'started'
      ? 'in_progress'
      : stateType === 'completed' || stateType === 'canceled'
        ? 'done'
        : 'todo';
    const identifier = String(issue.identifier ?? issue.id ?? '');
    return {
      id: `linear:${identifier}`,
      source: 'linear',
      title: String(issue.title ?? ''),
      description: issue.description ? String(issue.description) : undefined,
      status,
      priority: priority[Number(issue.priority)],
      metadata: {
        identifier,
        url: issue.url ? String(issue.url) : undefined,
        labels,
        assignee: issue.assignee?.name ? String(issue.assignee.name) : undefined,
        assigneeKind: assigneeKind(issue.assignee?.name),
        state: issue.state?.name ? String(issue.state.name) : undefined,
        createdAt: issue.createdAt ? String(issue.createdAt) : undefined,
        dueDate: issue.dueDate ? String(issue.dueDate) : undefined,
        project: issue.project?.name ? String(issue.project.name) : undefined,
        comments,
        images: imageUrls(issue.description, ...comments.map(comment => comment.body)),
      },
    };
  });
  return { tickets, cycleInfo };
}

async function readGithub(cwd: string, assignedOnly: boolean): Promise<TicketRow[]> {
  const repo = (await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd,
    timeout: 5_000,
  })).stdout.trim();
  if (!repo) throw new Error('No GitHub repository resolved for this workspace.');
  const args = [
    'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '50',
    '--json', 'number,title,state,labels,assignees,url,body,createdAt',
  ];
  if (assignedOnly) args.push('--assignee', '@me');
  const { stdout } = await run('gh', args, { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  const issues = JSON.parse(stdout) as any[];
  return issues.map((issue): TicketRow => {
    const assignee = issue.assignees?.[0]?.login ? String(issue.assignees[0].login) : undefined;
    const number = Number(issue.number);
    return {
      id: `github:${number}`,
      source: 'github',
      title: String(issue.title ?? ''),
      description: issue.body ? String(issue.body) : undefined,
      status: String(issue.state ?? '').toLowerCase() === 'closed' ? 'done' : 'todo',
      metadata: {
        identifier: `#${number}`,
        url: issue.url ? String(issue.url) : undefined,
        labels: (issue.labels ?? []).map((label: any) => String(label.name)),
        assignee,
        assigneeKind: assigneeKind(assignee),
        state: String(issue.state ?? '').toLowerCase(),
        createdAt: issue.createdAt ? String(issue.createdAt) : undefined,
        repo,
        images: imageUrls(issue.body),
      },
    };
  });
}

export async function listTickets(options: TicketListOptions): Promise<TicketListResult> {
  const result: TicketListResult = {
    tickets: [],
    cycleInfo: null,
    sources: {
      linear: { available: false },
      github: { available: false },
    },
  };

  const [linear, github] = await Promise.all([
    options.linear
      ? readLinear(options.cwd).then(value => ({ ok: true as const, value })).catch(error => ({ ok: false as const, error }))
      : Promise.resolve(null),
    options.github
      ? readGithub(options.cwd, options.githubAssignedOnly).then(value => ({ ok: true as const, value })).catch(error => ({ ok: false as const, error }))
      : Promise.resolve(null),
  ]);

  if (linear?.ok) {
    result.sources.linear.available = true;
    result.tickets.push(...linear.value.tickets);
    result.cycleInfo = linear.value.cycleInfo;
  } else if (linear) {
    result.sources.linear.error = errorMessage(linear.error);
  }
  if (github?.ok) {
    result.sources.github.available = true;
    result.tickets.push(...github.value);
  } else if (github) {
    result.sources.github.error = errorMessage(github.error);
  }
  return result;
}
