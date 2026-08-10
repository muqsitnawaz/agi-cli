import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectTeammateAddDirs } from './agents.js';
import { writeProjectDef, loadProjectDef, type ProjectDef } from '../projects.js';

// RUSH-2487: a team bound to a defined project (`teams create --project`) grants
// each local teammate the project's SECONDARY bound dirs via --add-dir. This is
// the pure list `resolveProjectAddDirs` feeds into `buildCommand`.
describe('projectTeammateAddDirs — a project-bound team grants the secondary dirs', () => {
  let projDir: string;
  let primary: string;
  let web: string;
  let sys: string;
  let def: ProjectDef;

  beforeAll(() => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-team-adddirs-'));
    process.env.AGENTS_PROJECTS_DIR = projDir;
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'proj-team-dirs-')));
    primary = path.join(base, 'agents-cli');
    web = path.join(base, 'agents-cli-web');
    sys = path.join(base, 'dot-system');
    for (const d of [primary, web, sys]) fs.mkdirSync(d, { recursive: true });
    writeProjectDef({
      name: 'projteamtest',
      root: primary,
      defaultPath: primary,
      repos: [
        { slug: 'a/agents-cli', path: primary },
        { slug: 'a/agents-cli-web', path: web },
        { slug: 'a/dot-system', path: sys },
      ],
    });
    def = loadProjectDef('projteamtest')!;
  });
  afterAll(() => {
    delete process.env.AGENTS_PROJECTS_DIR;
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it('cwd = primary → the two secondary dirs, primary never duplicated', () => {
    expect(projectTeammateAddDirs(def, primary)).toEqual([web, sys]);
  });

  it('cwd = a secondary → that dir is filtered out of the grants', () => {
    expect(projectTeammateAddDirs(def, web)).toEqual([sys]);
  });

  it('cwd = a worktree outside the project dirs → all secondaries granted', () => {
    const wt = path.join(primary, '.agents', 'worktrees', 'feat');
    expect(projectTeammateAddDirs(def, wt)).toEqual([web, sys]);
  });
});
