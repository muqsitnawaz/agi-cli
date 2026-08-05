import { test, describe, expect } from 'bun:test';
import { defToManaged, projectNameFromPath } from './managedProjects';
import * as os from 'os';
import * as path from 'path';

const HOME = os.homedir();

describe('projectNameFromPath', () => {
  test('returns the folder basename', () => {
    expect(projectNameFromPath('/Users/me/src/github.com/phnx-labs/agents-cli')).toBe('agents-cli');
    expect(projectNameFromPath('/a/b/')).toBe('b');
    expect(projectNameFromPath('foo')).toBe('foo');
  });
});

describe('defToManaged', () => {
  test('maps name to id and name', () => {
    const m = defToManaged({ name: 'rush', root: '~/src/rush' });
    expect(m.id).toBe('rush');
    expect(m.name).toBe('rush');
    expect(m.confidence).toBe('high');
    expect(m.source).toBe('manual');
  });

  test('expands home-relative root to absolute path', () => {
    const m = defToManaged({ name: 'rush', root: '~/src/rush' });
    expect(m.path).toBe(path.join(HOME, 'src/rush'));
  });

  test('falls back to defaultPath when root is absent', () => {
    const m = defToManaged({ name: 'rush', defaultPath: '~/src/rush/apps/web' });
    expect(m.path).toBe(path.join(HOME, 'src/rush/apps/web'));
  });

  test('leaves absolute paths unchanged', () => {
    const m = defToManaged({ name: 'rush', root: '/abs/path' });
    expect(m.path).toBe('/abs/path');
  });

  test('maps linear.projectId and linear.name', () => {
    const m = defToManaged({ name: 'rush', linear: { projectId: 'lin_1', name: 'Rush', url: 'https://linear.app/x' } });
    expect(m.linearProjectId).toBe('lin_1');
    expect(m.linearProjectName).toBe('Rush');
  });

  test('maps dispatch.enabled to autoDispatch', () => {
    const on = defToManaged({ name: 'rush', dispatch: { enabled: true } });
    expect(on.autoDispatch).toBe(true);

    const off = defToManaged({ name: 'rush', dispatch: { enabled: false } });
    expect(off.autoDispatch).toBe(false);

    const absent = defToManaged({ name: 'rush' });
    expect(absent.autoDispatch).toBe(false);
  });

  test('maps dispatch.maxAgents', () => {
    const m = defToManaged({ name: 'rush', dispatch: { enabled: true, maxAgents: 4 } });
    expect(m.maxAgents).toBe(4);

    const none = defToManaged({ name: 'rush' });
    expect(none.maxAgents).toBeUndefined();
  });

  test('maps repo slug from top-level repo field', () => {
    const m = defToManaged({ name: 'rush', repo: 'phnx-labs/rush' });
    expect(m.repoSlug).toBe('phnx-labs/rush');
  });

  test('falls back to repos[0].slug when repo is absent', () => {
    const m = defToManaged({ name: 'rush', repos: [{ slug: 'phnx-labs/rush' }, { slug: 'phnx-labs/other' }] });
    expect(m.repoSlug).toBe('phnx-labs/rush');
  });

  test('prefers top-level repo over repos[0].slug', () => {
    const m = defToManaged({ name: 'rush', repo: 'phnx-labs/rush', repos: [{ slug: 'phnx-labs/other' }] });
    expect(m.repoSlug).toBe('phnx-labs/rush');
  });

  test('empty name yields empty id and name', () => {
    const m = defToManaged({});
    expect(m.id).toBe('');
    expect(m.name).toBe('');
  });
});
