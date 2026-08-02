import { describe, expect, it } from 'vitest';
import {
  buildLocalFindings,
  fleetDivergenceToFindings,
  signInToFindings,
  remediationFor,
  renderFindings,
  renderAccountsLine,
  type DoctorFinding,
  type LocalFindingInputs,
} from './doctor-findings.js';
import type { VersionResourceReport } from '../doctor-diff.js';
import type { FleetVersionSignIn, FleetDivergence } from './fleet-divergence.js';

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

// A minimal VersionResourceReport with all resource kinds empty; tests fill in
// only the rows they exercise.
function report(
  agent: VersionResourceReport['agent'],
  version: string,
  kinds: Partial<VersionResourceReport['kinds']> = {},
  hookWiring?: VersionResourceReport['hookWiring'],
): VersionResourceReport {
  const empty = { commands: [], skills: [], hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], promptcuts: [] };
  return {
    agent, version, home: `/h/${agent}/${version}`, cwd: '/cwd',
    layers: { project: null, user: '/u', system: '/s', extras: [] },
    kinds: { ...empty, ...kinds },
    summary: { ok: 0, diff: 0, missing: 0, extra: 0 },
    hookWiring,
  };
}

function localInput(over: Partial<LocalFindingInputs> = {}): LocalFindingInputs {
  return {
    device: 'boxA',
    syncRows: [],
    orphanRows: [],
    repoBehind: [],
    reports: [],
    signIn: {},
    ...over,
  };
}

describe('severity rubric', () => {
  it('a missing hook from a synced version is CRITICAL', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', { hooks: [{ kind: 'hooks', name: 'git-guard', status: 'missing' }] })],
      // NOT never-synced (no syncRow), so it's a per-hook critical, not collapsed.
    }));
    const crit = findings.find((f) => f.kind === 'missing-hook');
    expect(crit?.severity).toBe('critical');
    expect(crit?.message).toContain("hook 'git-guard' missing");
  });

  it('a missing plugin from a synced version is CRITICAL', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', { plugins: [{ kind: 'plugins', name: 'rush', status: 'missing' }] })],
    }));
    const crit = findings.find((f) => f.kind === 'missing-plugin');
    expect(crit?.severity).toBe('critical');
    expect(crit?.message).toContain("plugin 'rush' missing");
  });

  it('a missing COMMAND is a WARNING (not critical)', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', { commands: [{ kind: 'commands', name: 'audit', status: 'missing' }] })],
    }));
    const f = findings.find((x) => x.kind === 'missing-resource');
    expect(f?.severity).toBe('warning');
    expect(findings.some((x) => x.severity === 'critical')).toBe(false);
  });

  it('an unwired hook is CRITICAL', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', {}, { supported: true, unwired: [{ name: 'rm-guard', event: 'PreToolUse' } as any], settingsMissing: false, settingsUnparseable: false, expected: 1 } as any)],
    }));
    const f = findings.find((x) => x.kind === 'unwired-hook');
    expect(f?.severity).toBe('critical');
    expect(f?.message).toContain("hook 'rm-guard'");
  });

  it('a never-synced version collapses its missing resources to ONE critical', () => {
    const hooks = Array.from({ length: 20 }, (_, i) => ({ kind: 'hooks' as const, name: `h${i}`, status: 'missing' as const }));
    const findings = buildLocalFindings(localInput({
      reports: [report('opencode', '1.16.0', { hooks })],
      syncRows: [{ agent: 'opencode', version: '1.16.0', status: 'never-synced', isDefault: true }],
    }));
    const crits = findings.filter((f) => f.severity === 'critical');
    expect(crits).toHaveLength(1);
    expect(crits[0].message).toContain('never synced');
    expect(crits[0].message).toContain('20 hook');
    // No duplicate never-synced WARNING when the critical already covered it.
    expect(findings.some((f) => f.kind === 'never-synced')).toBe(false);
  });

  it('a stale version is a WARNING', () => {
    const findings = buildLocalFindings(localInput({
      syncRows: [{ agent: 'claude', version: '2.1.0', status: 'stale', isDefault: true }],
    }));
    expect(findings.find((f) => f.kind === 'stale')?.severity).toBe('warning');
  });

  it('repo-behind and orphan are WARNINGS', () => {
    const findings = buildLocalFindings(localInput({
      repoBehind: [{ alias: 'user', dir: '/u', ahead: 0, behind: 6, branch: 'origin/main', fetchedAt: 0 }],
      orphanRows: [{ agent: 'claude', version: '2.1.0', commands: 2, skills: 0, hooks: 0 }],
    }));
    expect(findings.find((f) => f.kind === 'repo-behind')?.severity).toBe('warning');
    expect(findings.find((f) => f.kind === 'orphan')?.severity).toBe('warning');
  });
});

describe('signInToFindings — provable vs unprovable logout', () => {
  it('a PROVABLE logout is CRITICAL', () => {
    const findings = signInToFindings('boxA', {
      codex: [{ version: '1.0.0', signedIn: false, account: null, provable: true }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].kind).toBe('logged-out');
  });

  it('an UNPROVABLE logout is a hedged WARNING', () => {
    const findings = signInToFindings('boxA', {
      kimi: [{ version: '0.1.0', signedIn: false, account: null, provable: false }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].kind).toBe('logout-unprovable');
    expect(findings[0].message).toContain('could not verify');
  });

  it('a signed-in version yields NO finding', () => {
    const findings = signInToFindings('boxA', {
      claude: [{ version: '2.1.0', signedIn: true, account: 'me@x.com', provable: false }],
    });
    expect(findings).toHaveLength(0);
  });

  it('an agent with NO inspectable identity (cursor/antigravity) never yields a logout finding', () => {
    // antigravity is not in ACCOUNT_INSPECTION set? It IS inspectable, but cursor
    // is NOT — a cursor logged-out row must produce nothing.
    const findings = signInToFindings('boxA', {
      cursor: [{ version: '1.0.0', signedIn: false, account: null, provable: true }],
    });
    expect(findings).toHaveLength(0);
  });
});

describe('remediationFor', () => {
  const base = { severity: 'critical' as const, device: 'd', message: 'm', remediation: '' };

  it('an isolated agent gets a per-version login (agents run <agent>@<version>, then native)', () => {
    const r = remediationFor({ ...base, kind: 'logged-out', agent: 'codex', version: '1.2.3' });
    expect(r).toBe('agents run codex@1.2.3, then codex login');
  });

  it('claude uses its TUI /login for a per-version fix', () => {
    const r = remediationFor({ ...base, kind: 'logged-out', agent: 'claude', version: '2.1.0' });
    expect(r).toBe('agents run claude@2.1.0, then claude, then /login');
  });

  it.each(['gemini', 'antigravity', 'droid', 'cursor'] as const)(
    '%s has NO per-version isolation → shared login (no fake per-version fix)',
    (agent) => {
      const r = remediationFor({ ...base, kind: 'logged-out', agent, version: '9.9.9' });
      expect(r).not.toContain('agents run');
      expect(r).toContain('shared across all');
    },
  );

  it('opencode uses `auth login`', () => {
    const r = remediationFor({ ...base, kind: 'logged-out', agent: 'opencode', version: '1.0.0' });
    expect(r).toBe('agents run opencode@1.0.0, then opencode auth login');
  });

  it('a missing hook → agents doctor <agent>@<version> --fix', () => {
    expect(remediationFor({ ...base, kind: 'missing-hook', agent: 'claude', version: '2.1.0' }))
      .toBe('agents doctor claude@2.1.0 --fix');
  });

  it('never-synced → agents sync; orphan → prune cleanup; repo-behind → repo pull', () => {
    expect(remediationFor({ ...base, kind: 'never-synced', agent: 'claude', version: '2.1.0' }))
      .toBe('agents sync claude@2.1.0 --yes');
    expect(remediationFor({ ...base, kind: 'orphan', agent: 'claude', version: '2.1.0' }))
      .toBe('agents prune cleanup');
    expect(remediationFor({ ...base, kind: 'repo-behind', version: 'user' }))
      .toBe('agents repo pull user');
  });

  it('stale-cli → upgrade', () => {
    expect(remediationFor({ ...base, kind: 'stale-cli' })).toBe('upgrade');
  });
});

describe('fleetDivergenceToFindings', () => {
  it('maps a version gap to a version-skew warning on the lagging box', () => {
    const d: FleetDivergence = {
      kind: 'agent-version-missing-remote', device: 'boxB', category: 'claude', name: '2.1.220',
      message: 'boxB is missing claude@2.1.220 (installed on boxA)',
    };
    const findings = fleetDivergenceToFindings([d], 'boxA');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning', kind: 'version-skew', device: 'boxB' });
  });

  it('attributes a *-missing-local finding to the baseline (the lagging box)', () => {
    const d: FleetDivergence = {
      kind: 'agent-version-missing-local', device: 'boxB', category: 'grok', name: '1.4',
      message: 'boxA is missing grok@1.4 (installed on boxB)',
    };
    const findings = fleetDivergenceToFindings([d], 'boxA');
    expect(findings[0].device).toBe('boxA');
  });

  it('maps repo drift to a repo-drift warning', () => {
    const d: FleetDivergence = {
      kind: 'repo-drift', device: 'boxB', category: 'agents', name: '.agents',
      message: 'boxB .agents repo diverged: HEAD abc != local def',
    };
    expect(fleetDivergenceToFindings([d], 'boxA')[0]).toMatchObject({ kind: 'repo-drift', device: 'boxB' });
  });
});

describe('renderAccountsLine', () => {
  it('renders every version + its account, provable ✓/✗', () => {
    const line = stripAnsi(renderAccountsLine({
      claude: [
        { version: '2.1.170', signedIn: true, account: 'me@x.com (Max)', provable: false },
        { version: '2.1.999', signedIn: true, account: 'team@y (Team)', provable: false },
      ],
      codex: [{ version: '0.1.0', signedIn: false, account: null, provable: true }],
    }));
    expect(line).toContain('claude 2.1.170 ✓me@x.com (Max) 2.1.999 ✓team@y (Team)');
    expect(line).toContain('codex ✗');
    expect(line).toContain(' · ');
  });

  it('collapses a single-version agent to `<agent> <badge>`', () => {
    const line = stripAnsi(renderAccountsLine({ grok: [{ version: '0.2', signedIn: true, account: null, provable: false }] }));
    expect(line).toBe('grok ✓');
  });
});

describe('renderFindings — exact layout', () => {
  const accounts: Record<string, Record<string, FleetVersionSignIn[]>> = {
    zion: {
      claude: [{ version: '2.1.170', signedIn: true, account: 'me@x.com (Max)', provable: false }],
      codex: [{ version: '0.1', signedIn: false, account: null, provable: true }],
    },
  };

  it('single-machine (fleet=false): CRITICAL section + one ▸ block, no fleet header', () => {
    const findings: DoctorFinding[] = [
      { severity: 'critical', kind: 'logged-out', device: 'zion', agent: 'codex', version: '0.1', account: null, message: 'logged out — no account signed in', remediation: 'codex login' },
      { severity: 'warning', kind: 'repo-behind', device: 'zion', version: 'user', message: '6 behind origin/main', remediation: 'agents repo pull user' },
    ];
    const out = stripAnsi(renderFindings(findings, accounts, { fleet: false, baseline: 'zion', header: 'agents doctor · zion' }).join('\n'));
    expect(out).toContain('✗ CRITICAL — needs you now  (1)');
    expect(out).toContain('▸ zion · this machine  ✗ 1 critical (above)');
    expect(out).not.toContain('─── by computer ───');
    // The critical row (single-machine: no device column) names version + fix.
    expect(out).toContain('codex @0.1');
    expect(out).toContain('→ codex login');
    // The warning appears under the block.
    expect(out).toContain('⚠');
    // Accounts line present — single-version agents collapse to `<agent> <badge>`,
    // logged-out codex shows ✗.
    expect(out).toContain('claude ✓me@x.com (Max)');
    expect(out).toContain('codex ✗');
  });

  it('fleet (fleet=true): CRITICAL section shows the device column + by-computer header', () => {
    const findings: DoctorFinding[] = [
      { severity: 'critical', kind: 'logged-out', device: 'zion', agent: 'codex', version: '0.1', account: null, message: 'logged out — no account signed in', remediation: 'codex login' },
      { severity: 'warning', kind: 'version-skew', device: 'yos-s1', agent: 'grok', version: '1.4', message: 'not installed (present elsewhere in the fleet)', remediation: 'agents add grok@1.4' },
    ];
    const fleetAccounts = { ...accounts, 'yos-s1': { claude: [{ version: '2.1.170', signedIn: true, account: null, provable: false }] } };
    const out = stripAnsi(renderFindings(findings, fleetAccounts, { fleet: true, baseline: 'zion', header: 'agents doctor · 2 devices · baseline zion' }).join('\n'));
    expect(out).toContain('─── by computer ───');
    // Device column present in the critical row.
    expect(out).toMatch(/zion\s+codex @0\.1/);
    // Worst box (zion, has a critical) sorts before yos-s1 (warning only).
    expect(out.indexOf('▸ zion')).toBeLessThan(out.indexOf('▸ yos-s1'));
    // The version-skew warning lands under yos-s1.
    expect(out).toMatch(/grok @1\.4\s+not installed/);
  });

  it('all-clear: no criticals, no warnings → ✓ lines only', () => {
    const cleanAccounts = { zion: { claude: [{ version: '2.1.170', signedIn: true, account: 'me@x.com', provable: false }] } };
    const out = stripAnsi(renderFindings([], cleanAccounts, { fleet: false, baseline: 'zion', header: 'agents doctor · zion' }).join('\n'));
    expect(out).toContain('✗ CRITICAL — needs you now  (0)');
    expect(out).toContain('nothing critical across the fleet');
    expect(out).toContain('✓ no warnings');
    expect(out).toContain('claude ✓me@x.com');
  });
});
