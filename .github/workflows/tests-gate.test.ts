/**
 * Pin the required Tests workflow to one affected Linux check (RUSH-2666).
 *
 * Branch protection and release.sh wait on the stable `Tests / test` context.
 * Shards, preflight, and Windows must not sit on that path.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_YML = readFileSync(join(import.meta.dir, 'tests.yml'), 'utf8');

describe('tests.yml required Linux gate', () => {
  test('keeps a single job named test as the required check', () => {
    expect(TESTS_YML).toMatch(/^  test:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-test-shard:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-preflight:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  cli-docs:\s*$/m);
    expect(TESTS_YML).not.toMatch(/^  scope:\s*$/m);
    expect(TESTS_YML).not.toMatch(/shard: \[1, 2, 3\]/);
  });

  test('Windows is not on the required path', () => {
    expect(TESTS_YML).not.toMatch(/needs: \[.*windows/);
    expect(TESTS_YML).toMatch(/if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    expect(TESTS_YML).toMatch(/continue-on-error: true/);
  });

  test('the Linux job plans with ci-scope and enforces the selected budget', () => {
    expect(TESTS_YML).toContain('bun scripts/ci-scope.ts');
    expect(TESTS_YML).toContain('--fail-unmapped');
    expect(TESTS_YML).toContain('--validate-manifest');
    expect(TESTS_YML).toContain('impact-proof-');
    // RUSH-2666 (wave 6): the workflow must NOT pass --deadline-sec here.
    // ci-scope.ts's own --run path already picks 1200s for a cli-full plan
    // and IMPACT_BUDGET_SEC (85s) for a selected plan; a hardcoded
    // `--deadline-sec 1200` in the workflow overrides that and silently
    // disables the 85s selected-run budget check on every PR.
    expect(TESTS_YML).not.toContain('--deadline-sec');
  });

  test('the required test job routes by PR provenance, forks stay GitHub-hosted', () => {
    // Two lanes, one required `test` context (RUSH-2773): same-repo PRs run on
    // the warm crabbox-ci pool, fork PRs fall back to ubuntu-latest and never
    // reach the self-hosted host. The routing is a single `runs-on` expression
    // keyed on GitHub-populated context a fork cannot forge.
    expect(TESTS_YML).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(TESTS_YML).toContain(
      `fromJSON('["self-hosted", "crabbox-ci", "tailnet"]')`,
    );
    // The fork lane is the GitHub-hosted runner.
    expect(TESTS_YML).toContain("|| 'ubuntu-latest'");
    // crabbox-ci must never appear as a bare/static runs-on a fork PR could land
    // on — only inside the provenance-guarded expression above.
    expect(TESTS_YML).not.toMatch(/runs-on: \[self-hosted/);
    expect(TESTS_YML).not.toMatch(/phnx-trusted/);
  });
});
