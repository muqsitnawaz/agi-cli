import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

export interface FactoryTaskResult { tasks: Record<string, unknown>[]; cycleInfo: Record<string, unknown> | null; sources: { linear: boolean; github: boolean } }

function images(...bodies: unknown[]): string[] {
  const urls = new Set<string>();
  const pattern = /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)|<img\b[^>]*?\bsrc\s*=\s*["'](https?:\/\/[^"']+)/gi;
  for (const body of bodies) {
    if (typeof body !== 'string') continue;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body))) urls.add(match[1] || match[2]);
  }
  return [...urls];
}

export async function listFactoryTasks(options: { cwd: string; linear: boolean; github: boolean; assignedOnly: boolean }): Promise<FactoryTaskResult> {
  const tasks: Record<string, unknown>[] = [];
  let cycleInfo: Record<string, unknown> | null = null;
  let linearAvailable = false;
  let githubAvailable = false;

  if (options.linear) {
    try {
      const { stdout } = await run('linear', ['tasks', '--json'], { cwd: options.cwd, timeout: 15_000 });
      const data = JSON.parse(stdout);
      linearAvailable = true;
      if (data.cycle?.startsAt && data.cycle?.endsAt) cycleInfo = { name: data.cycle.name, startsAt: data.cycle.startsAt, endsAt: data.cycle.endsAt };
      for (const issue of data.issues ?? []) {
        const labels = (issue.labels?.nodes ?? []).map((label: { name: string }) => label.name);
        const comments = (issue.comments?.nodes ?? []).map((comment: any) => ({ body: comment.body, createdAt: comment.createdAt, author: comment.user?.name }));
        const priority = ({ 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' } as Record<number, string>)[issue.priority];
        const status = ['started'].includes(issue.state?.type) ? 'in_progress' : ['completed', 'canceled'].includes(issue.state?.type) ? 'done' : 'todo';
        tasks.push({ id: `linear:${issue.identifier}`, source: 'linear', title: issue.title, description: issue.description, status, priority, metadata: { identifier: issue.identifier, url: issue.url, labels, assignee: issue.assignee?.name, assigneeKind: /^(claude|codex|gemini|cursor|opencode)$/i.test(issue.assignee?.name ?? '') ? 'agent' : issue.assignee?.name ? 'user' : undefined, state: issue.state?.name, createdAt: issue.createdAt, dueDate: issue.dueDate, project: issue.project?.name, comments, images: images(issue.description, ...comments.map((comment: any) => comment.body)) } });
      }
    } catch { /* source availability is explicit in the response */ }
  }

  if (options.github) {
    try {
      const repo = (await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: options.cwd, timeout: 5_000 })).stdout.trim();
      const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '50', '--json', 'number,title,state,labels,assignees,url,body,createdAt'];
      if (options.assignedOnly) args.push('--assignee', '@me');
      const issues = JSON.parse((await run('gh', args, { cwd: options.cwd, timeout: 15_000 })).stdout);
      githubAvailable = true;
      for (const issue of issues) tasks.push({ id: `github:${issue.number}`, source: 'github', title: issue.title, description: issue.body, status: issue.state?.toLowerCase() === 'closed' ? 'done' : 'todo', metadata: { identifier: `#${issue.number}`, url: issue.url, labels: (issue.labels ?? []).map((label: { name: string }) => label.name), assignee: issue.assignees?.[0]?.login, assigneeKind: issue.assignees?.[0]?.login ? 'user' : undefined, state: issue.state?.toLowerCase(), createdAt: issue.createdAt, repo, images: images(issue.body) } });
    } catch { /* source availability is explicit in the response */ }
  }
  return { tasks, cycleInfo, sources: { linear: linearAvailable, github: githubAvailable } };
}
