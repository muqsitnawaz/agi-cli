/**
 * Prioritized, fleet-aware findings model for `agents doctor` (RUSH-2069).
 *
 * The redesign is a HYBRID, comprehensive-by-default readout (no `--verbose`):
 *
 *   1. `✗ CRITICAL — needs you now  (N)` — EVERY critical across the whole fleet,
 *      worst-first, each `device · harness@version · account? · message →
 *      remediation`. A healthy machine can never bury a critical.
 *   2. `─── by computer ───` — one block per device (worst-first): that machine's
 *      WARNINGS plus a compact accounts/versions line listing every installed
 *      version and its account (provable ✓ / ✗). A device that has criticals
 *      carries a `✗ N critical (above)` marker; the criticals stay at the top.
 *
 * A single-machine `agents doctor` (no `--devices`) collapses to the CRITICAL
 * section, then one `▸ <machine>` block.
 *
 * Severity rubric (agent-agnostic):
 *   CRITICAL — provable logged-out · missing hook or plugin from a version ·
 *              cli-missing / binary-broken.
 *   WARNING  — content-drift · never-synced · version-skew · repo-behind ·
 *              repo-drift · orphan · missing command/skill/rule/mcp/permission/
 *              subagent · UNPROVABLE logout (hedged wording).
 *
 * This module is pure: it maps already-collected signals (drift rows, orphan
 * rows, repo-behind markers, per-version resource diffs, cross-device divergence,
 * and per-version sign-in) into {@link DoctorFinding}s and renders them. The SSH
 * fan-out and the live probes live in the doctor command; here we only shape and
 * format, so the layout is unit-tested against fixtures with no live fleet.
 */
import chalk from 'chalk';
import { AGENTS, ALL_AGENT_IDS, supportsAccountInspection } from '../agents.js';
import { blocksLocalScripts } from '../platform/winpath.js';
import { loginHint } from '../signin-badge.js';
import { padToWidth, stringWidth } from '../session/width.js';
import type { AgentId } from '../types.js';
import type { DuplicateVersionHook } from '../hooks.js';
import type { RcSecretFinding } from '../secrets/rc-hygiene.js';
import type { SyncStatusRow, OrphanRow } from '../drift.js';
import type { FetchStatusMarker } from '../auto-pull.js';
import type { VersionResourceReport } from '../doctor-diff.js';
import type {
  FleetDivergence,
  FleetVersionSignIn,
} from './fleet-divergence.js';

const AGENT_NAMES: Record<string, string> = Object.fromEntries(
  ALL_AGENT_IDS.map((id) => [id, AGENTS[id].name]),
);

/** Agents with NO per-version credential isolation: their login is shared across
 *  every installed version (no per-version isolation env var to point native
 *  login at one home), so a "log into THIS version" remediation would be a lie —
 *  the login is global. `agents run <agent>@<version>` targets a specific home
 *  only for the isolated set (claude/codex/grok/kimi/opencode/copilot). */
const NO_PER_VERSION_LOGIN = new Set<AgentId>(['gemini', 'antigravity', 'droid', 'cursor']);

/** How an agent's login is actually reached — the three shapes `loginHint`
 *  encodes (`lib/signin-badge.ts:23-36`), split apart because a per-version fix
 *  has to build a different command for each:
 *    `subcommand` — `<cli> login` / `<cli> auth login`, runnable via `--`
 *    `in-tui`     — claude only: a `/login` slash command inside its own TUI
 *    `on-launch`  — the device/oauth flow starts when the agent launches */
const LOGIN_SUBCOMMAND: Partial<Record<AgentId, string>> = {
  codex: 'login',
  grok: 'login',
  opencode: 'auth login',
};

function loginShape(agent: AgentId): 'subcommand' | 'in-tui' | 'on-launch' {
  if (LOGIN_SUBCOMMAND[agent]) return 'subcommand';
  return agent === 'claude' ? 'in-tui' : 'on-launch';
}

export type FindingSeverity = 'critical' | 'warning';

/** A machine-stable class for a finding — drives {@link remediationFor} and lets
 *  the JSON consumer group by kind. */
export type FindingKind =
  | 'logged-out'          // provable per-version logout (CRITICAL)
  | 'logout-unprovable'   // credential absent but not provable (WARNING)
  | 'missing-hook'        // a declared hook absent from a version home (CRITICAL)
  | 'missing-plugin'      // a declared plugin absent from a version home (CRITICAL)
  | 'unwired-hook'        // hook present on disk but not wired into settings.json (CRITICAL)
  | 'cli-missing'         // a managed agent whose binary won't resolve (CRITICAL)
  | 'missing-resource'    // a missing command/skill/rule/mcp/permission/subagent (WARNING)
  | 'content-drift'       // a resource diverged from source (WARNING)
  | 'never-synced'        // installed but never synced — CRITICAL when its declared
                          // resources are therefore absent, WARNING when it declares none
  | 'stale'               // sources changed since last sync (WARNING)
  | 'repo-behind'         // a config repo behind origin (WARNING)
  | 'repo-drift'          // a config repo diverged from the fleet baseline (WARNING)
  | 'fleet-resource-gap'  // a resource in another box's central repos, absent here (WARNING)
  | 'host-cli-missing'    // a declared host CLI not installed on this box (WARNING)
  | 'host-cli-invalid'    // a host-CLI manifest that failed to parse (WARNING)
  | 'version-skew'        // an agent version present elsewhere, absent here (WARNING)
  | 'orphan'              // orphan resources in a version home (WARNING)
  | 'duplicate-hook'      // one hook materialized in several version homes, byte-identical (WARNING)
  | 'duplicate-hook-drift'// …with differing content, so a stale copy can disagree (CRITICAL)
  | 'rc-secret-export'    // credential-shaped export in a shell rc file (WARNING)
  | 'exec-policy'         // Windows execution policy blocks agents.ps1 (WARNING)
  | 'stale-cli';          // an older CLI that can't report per-version sign-in (WARNING)

/** One prioritized finding, attributed to a device (and, when relevant, an agent
 *  version + account). `remediation` is the exact command/hint to fix it. */
export interface DoctorFinding {
  severity: FindingSeverity;
  kind: FindingKind;
  /** The device this finding is about. */
  device: string;
  /** Agent id, when the finding is about a specific agent (else undefined). */
  agent?: AgentId;
  /** Version id, when about a specific installed version. Absent on a finding
   *  collapsed across versions — read {@link DoctorFinding.versions} instead. */
  version?: string;
  /** Set only on a finding collapsed across several versions of one agent (the
   *  same problem on each). The row renders `<agent> (N versions)` and the
   *  remediation widens to the agent-wide sweep. */
  versions?: string[];
  /** Human account label (email/org/opaque id), when known. */
  account?: string | null;
  /** One-line plain-English description of the problem. */
  message: string;
  /** Exact remediation command / hint. */
  remediation: string;
}

function agentName(agent: AgentId): string {
  return AGENT_NAMES[agent] || agent;
}

/**
 * The exact remediation for a finding. Login fixes are harness-native
 * (`loginHint`); a per-version login is offered ONLY for agents that isolate the
 * credential per home (`agents run <agent>@<version>` then log in) — for
 * gemini/antigravity/droid/cursor the login is shared, so we say so instead of
 * faking a per-version fix. Every other kind maps to its canonical command.
 */
export function remediationFor(finding: DoctorFinding): string {
  const { kind, agent, version } = finding;
  const idLabel = agent && version ? `${agent}@${version}` : agent ?? '';
  switch (kind) {
    case 'logged-out':
    case 'logout-unprovable': {
      if (!agent) return 'log in';
      const native = loginHint(agent);
      if (!version || NO_PER_VERSION_LOGIN.has(agent)) {
        // Shared login across versions — no per-version isolation to target.
        return NO_PER_VERSION_LOGIN.has(agent)
          ? `${native} (shared across all ${agentName(agent)} versions)`
          : native;
      }
      // Isolated per-version home: the login must RUN INSIDE that home. A bare
      // `<cli> login` afterwards would NOT — the native shim resolves to the
      // project/default version (`lib/shims.ts:471-474`), so it would log into
      // whichever version is default, not the one that is logged out.
      switch (loginShape(agent)) {
        case 'subcommand':
          // `-- <args>` is forwarded verbatim to the binary in that version home
          // (`commands/exec.ts:723`, `lib/exec.ts:1004`) — one correct invocation.
          return `agents run ${idLabel} -- ${LOGIN_SUBCOMMAND[agent]}`;
        case 'in-tui':
          // Claude has no login subcommand; it logs in from inside its own TUI.
          return `agents run ${idLabel}, then /login`;
        case 'on-launch':
          // The device/oauth flow starts when the agent launches — nothing to add.
          return `agents run ${idLabel}`;
      }
    }
    case 'missing-hook':
    case 'missing-plugin':
    case 'unwired-hook':
    case 'missing-resource':
    case 'content-drift':
    case 'stale':
      return idLabel ? `agents doctor ${idLabel} --fix` : 'agents doctor --fix';
    case 'never-synced':
      // A bare `agents sync <agent>` targets only the default/sole installed
      // version (`commands/sync.ts:8`), so a row collapsed across versions must
      // ask for the `@all` selector or it silently fixes just one of them.
      if (!agent) return 'agents sync';
      return version ? `agents sync ${agent}@${version} --yes` : `agents sync ${agent}@all --yes`;
    case 'cli-missing':
      return agent ? `agents add ${agent}` : 'agents add <agent>';
    case 'orphan':
      // Without `--all`, cleanup sweeps only each agent's DEFAULT version
      // (`commands/prune.ts:351`, `collectOrphans(..., options.all === true)`) —
      // and this row aggregates every version on the machine.
      return 'agents prune cleanup --all';
    case 'repo-behind':
      return `agents repo pull ${finding.version ?? 'user'}`;
    case 'repo-drift':
      // `version` carries the repo alias (`user` for ~/.agents, `system` for
      // ~/.agents/.system) — hardcoding `user` would send a `.system` drift at
      // the wrong repo.
      return `agents repo pull ${version ?? 'user'}`;
    case 'fleet-resource-gap':
      // The resource is absent from this box's CENTRAL repos, not from a version
      // home, so `agents doctor --fix` (which reconciles central -> homes) has
      // nothing to copy. The divergence row cannot say WHICH repo declares it,
      // and neither `agents repo pull` nor the sync umbrella touches the system
      // repo (`commands/repo.ts:1186`, `lib/sync-umbrella.ts:104`) — that one is
      // npm-shipped and moves with the CLI. So name both paths rather than a
      // single command that silently covers half the cases.
      return 'agents repo pull user (or upgrade agents-cli if it ships in .system)';
    case 'version-skew':
      return idLabel ? `agents add ${idLabel}` : 'agents add <agent>@<version>';
    case 'duplicate-hook':
    case 'duplicate-hook-drift':
      // The copies live in SEVERAL version homes, so the reconcile has to reach
      // every one — `agents sync <agent>@<one-version>` would leave the others
      // holding their stale copy.
      return agent ? `agents sync ${agent}@all --yes` : 'agents sync';
    case 'host-cli-missing':
      return 'agents cli install';
    case 'host-cli-invalid':
      // Nothing installs a manifest the loader cannot parse — the file has to be
      // fixed where it is declared.
      return 'fix the manifest';
    case 'rc-secret-export':
      return 'agents secrets add';
    case 'exec-policy':
      return 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned';
    case 'stale-cli':
      return 'upgrade';
  }
}

function finding(f: Omit<DoctorFinding, 'remediation'>): DoctorFinding {
  return { ...f, remediation: remediationFor({ ...f, remediation: '' }) };
}

/** One affected resource inside a group: `short` is the bare subject used in a
 *  collapsed count line (`'git-guard'`, `command 'audit'`), `full` is the whole
 *  sentence used when the group holds exactly one item. */
interface ResourceItem {
  short: string;
  full: string;
}

/**
 * Emit at most ONE finding for a list of same-kind resources on one version.
 * A single affected resource is named in full (`hook 'git-guard' missing`); two
 * or more collapse into a count plus the first two subjects
 * (`32 hooks missing (incl. 'git-guard', 'rm-guard')`). Naming every item — the
 * pre-RUSH-2069-review behavior — flooded the section with dozens of near-identical
 * rows for one root cause; the count carries the same signal and `--fix` is the
 * same command either way.
 */
function emitGroup(
  out: DoctorFinding[],
  items: ResourceItem[],
  severity: FindingSeverity,
  kind: FindingKind,
  device: string,
  agent: AgentId,
  version: string,
  noun: string,
  verb: 'missing' | 'drifted',
): void {
  if (items.length === 0) return;
  const message = items.length === 1
    ? items[0].full
    : `${items.length} ${noun}s ${verb} (incl. ${items.slice(0, 2).map((i) => i.short).join(', ')})`;
  out.push(finding({ severity, kind, device, agent, version, message }));
}

// ─── local (this-machine) findings ──────────────────────────────────────────

export interface LocalFindingInputs {
  device: string;
  syncRows: SyncStatusRow[];
  orphanRows: OrphanRow[];
  repoBehind: FetchStatusMarker[];
  /** Per-version resource reports (one per installed version) — the source of the
   *  missing-hook / missing-plugin / missing-resource / content-drift / unwired
   *  criticals+warnings. */
  reports: VersionResourceReport[];
  /** Per-version sign-in per agent id. */
  signIn: Record<string, FleetVersionSignIn[]>;
  /** Managed agents (installed versions) whose binary won't resolve. */
  cliMissing?: AgentId[];
  /** Host CLIs declared in a DotAgents repo's `cli/`: their install state on this
   *  box, plus any manifest the loader could not parse. Host-global (installed to
   *  PATH, never synced into a version home), so they are a machine-level
   *  finding, not a per-version one. */
  hostClis?: {
    statuses: Array<{ name: string; installed: boolean }>;
    errors: Array<{ file: string; reason: string }>;
  };
  /** Hooks materialized into several version homes at once — identical copies are
   *  installation noise, differing ones are drift a stale gate can act on. */
  duplicateHooks?: DuplicateVersionHook[];
  /** Credential-shaped exports found in the user's shell rc files (RUSH-1968). */
  rcSecrets?: RcSecretFinding[];
  /** The effective PowerShell execution policy and the platform it was read on.
   *  Only `win32` yields a finding — the `agents.ps1` launcher is Windows-only. */
  execPolicy?: { platform: NodeJS.Platform; policy: string | null };
  /** `<agent>@<version>` keys whose home is an isolated copy. Their findings are
   *  never collapsed across versions: the agent-wide `agents doctor <agent> --fix`
   *  sweep deliberately skips isolated copies, so a collapsed row would print a
   *  remediation that does not fix them. */
  isolatedVersions?: string[];
}

/**
 * Fold this machine's signals into findings. Missing hooks/plugins and unwired
 * hooks are CRITICAL; provable logouts are CRITICAL and unprovable ones WARNING;
 * everything else (other missing kinds, drift, stale/never-synced, repo-behind,
 * orphans) is a WARNING. Pure.
 */
export function buildLocalFindings(input: LocalFindingInputs): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const device = input.device;
  /** `<agent>@<version>` keys that already named their specific drift/missing
   *  resources below — a `stale` row for those would repeat the same fact in
   *  vaguer words, so it is suppressed. */
  const detailedVersions = new Set<string>();

  // cli-missing (managed agent, binary broken) — critical.
  for (const agent of input.cliMissing ?? []) {
    out.push(finding({
      severity: 'critical', kind: 'cli-missing', device, agent,
      message: `${agentName(agent)} binary not found`,
    }));
  }

  // Per-version resource reports → missing hook/plugin (critical), unwired hook
  // (critical), other missing kinds (warning), content drift (warning).
  for (const report of input.reports) {
    const agent = report.agent as AgentId;
    const version = report.version;
    const w = report.hookWiring;
    if (w?.supported) {
      if (w.settingsMissing) {
        out.push(finding({
          severity: 'critical', kind: 'unwired-hook', device, agent, version,
          message: `settings.json missing — ${w.expected ?? 0} declared hook${(w.expected ?? 0) === 1 ? '' : 's'} never fire`,
        }));
      } else if (w.settingsUnparseable) {
        out.push(finding({
          severity: 'critical', kind: 'unwired-hook', device, agent, version,
          message: `settings.json unparseable — hook wiring can't be verified`,
        }));
      } else {
        for (const u of w.unwired) {
          out.push(finding({
            severity: 'critical', kind: 'unwired-hook', device, agent, version,
            message: `hook '${u.name}' present on disk but not wired into settings.json`,
          }));
        }
      }
    }
    // A never-synced version has EVERY declared resource "missing" — that's one
    // root cause (never synced), not one emergency per hook. Collapse it to a
    // single critical rather than flooding the top section with 100+ lines. The
    // per-version `never-synced` warning below carries the sync remediation.
    const neverSynced = input.syncRows.some(
      (s) => s.agent === agent && s.version === version && s.status === 'never-synced',
    );

    const missingHooks: ResourceItem[] = [];
    const missingPlugins: ResourceItem[] = [];
    const missingOther: ResourceItem[] = [];
    const drifted: ResourceItem[] = [];
    for (const kind of ['commands', 'skills', 'hooks', 'rules', 'mcp', 'permissions', 'subagents', 'plugins', 'promptcuts'] as const) {
      const singular = kind.replace(/s$/, '');
      for (const r of report.kinds[kind] ?? []) {
        if (r.status === 'missing') {
          if (kind === 'hooks') missingHooks.push({ short: `'${r.name}'`, full: `hook '${r.name}' missing` });
          else if (kind === 'plugins') missingPlugins.push({ short: `'${r.name}'`, full: `plugin '${r.name}' missing` });
          else missingOther.push({ short: `${singular} '${r.name}'`, full: `${singular} '${r.name}' missing` });
        } else if (r.status === 'diff') {
          drifted.push({
            short: `${singular} '${r.name}'`,
            full: r.detail
              ? `${singular} '${r.name}' — ${r.detail}`
              : `${singular} '${r.name}' changed upstream — re-sync`,
          });
        }
      }
    }

    if (neverSynced) {
      // Everything is "missing" because it was never synced — one line, and a
      // CRITICAL one: nothing this version declares is actually installed.
      const total = missingHooks.length + missingPlugins.length + missingOther.length;
      if (total > 0) {
        const breakdown = [
          missingHooks.length ? `${missingHooks.length} hook${missingHooks.length === 1 ? '' : 's'}` : '',
          missingPlugins.length ? `${missingPlugins.length} plugin${missingPlugins.length === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(', ');
        out.push(finding({
          severity: 'critical', kind: 'never-synced', device, agent, version,
          message: `never synced — ${total} resource${total === 1 ? '' : 's'}${breakdown ? ` (incl. ${breakdown})` : ''} not installed`,
        }));
      }
    } else {
      // Synced-but-drifted: one line per kind of gap on this version.
      emitGroup(out, missingHooks, 'critical', 'missing-hook', device, agent, version, 'hook', 'missing');
      emitGroup(out, missingPlugins, 'critical', 'missing-plugin', device, agent, version, 'plugin', 'missing');
      emitGroup(out, missingOther, 'warning', 'missing-resource', device, agent, version, 'resource', 'missing');
      emitGroup(out, drifted, 'warning', 'content-drift', device, agent, version, 'resource', 'drifted');
      if (missingHooks.length + missingPlugins.length + missingOther.length + drifted.length > 0) {
        detailedVersions.add(`${agent}@${version}`);
      }
    }
  }

  // Sync status → stale (warning). A NEVER-SYNCED version already surfaced a
  // single collapsed critical above (its resources aren't installed at all), so
  // we don't ALSO emit a never-synced warning — that would double-report the same
  // root cause. Likewise a version that just listed its drifted/missing resources
  // by name gets no vaguer `sources changed since last sync` row on top.
  for (const row of input.syncRows) {
    if (row.status === 'stale') {
      if (detailedVersions.has(`${row.agent}@${row.version}`)) continue;
      out.push(finding({
        severity: 'warning', kind: 'stale', device, agent: row.agent, version: row.version,
        message: 'sources changed since last sync',
      }));
    } else if (row.status === 'never-synced') {
      // Only surface a never-synced warning when the collapsed critical above did
      // NOT fire (a version with zero declared resources to miss — nothing landed
      // in the critical section, so name the never-synced state here).
      const hadCritical = input.reports.some(
        (rep) => rep.agent === row.agent && rep.version === row.version &&
          Object.values(rep.kinds).some((rows) => rows.some((r) => r.status === 'missing')),
      );
      if (!hadCritical) {
        out.push(finding({
          severity: 'warning', kind: 'never-synced', device, agent: row.agent, version: row.version,
          message: 'installed but never synced',
        }));
      }
    }
  }

  // Repo-behind markers (warning). `version` carries the alias so remediationFor
  // can build `agents repo pull <alias>`.
  for (const m of input.repoBehind) {
    if (m.behind <= 0) continue;
    const stales = input.syncRows.filter((r) => r.status === 'stale').length;
    const staleNote = stales > 0 ? ` → stales ${stales} version${stales === 1 ? '' : 's'}` : '';
    out.push(finding({
      severity: 'warning', kind: 'repo-behind', device, version: m.alias,
      message: `${m.behind} behind ${m.branch}${staleNote}`,
    }));
  }

  // Orphans (warning) — ONE line for the whole device. Orphans are cleanup-only
  // and `agents prune cleanup` fixes every version at once, so a row per version
  // was the single largest block of noise in the readout for zero added action.
  out.push(...orphanFinding(device, input.orphanRows));

  // Host CLIs declared but not on PATH. One row for the machine, naming the
  // count and two examples — `agents cli install <name>` is per-CLI, so the
  // names have to survive into the message.
  const missingClis = (input.hostClis?.statuses ?? []).filter((c) => !c.installed).map((c) => c.name);
  if (missingClis.length > 0) {
    out.push({
      severity: 'warning', kind: 'host-cli-missing', device,
      message: missingClis.length === 1
        ? `host CLI '${missingClis[0]}' declared but not installed`
        : `${missingClis.length} declared host CLIs not installed (${missingClis.slice(0, 2).join(', ')}${missingClis.length > 2 ? ', …' : ''})`,
      // `agents cli install <name>` takes ONE optional name; with none it installs
      // every declared CLI that is missing (`commands/cli.ts:118,133-146`). A
      // second positional — or a literal ellipsis — is not a runnable command.
      remediation: missingClis.length === 1
        ? `agents cli install ${missingClis[0]}`
        : 'agents cli install',
    });
  }
  // A manifest the loader rejected declares a CLI that can never install — one
  // row per bad file, since each needs its own edit.
  for (const e of input.hostClis?.errors ?? []) {
    out.push(finding({
      severity: 'warning', kind: 'host-cli-invalid', device,
      message: `host-CLI manifest ${e.file} could not be read: ${e.reason}`,
    }));
  }

  out.push(...duplicateHookFindings(device, input.duplicateHooks ?? []));

  // Credential-shaped exports in shell rc files (RUSH-1968) — a warning per class
  // of fix: the file-store master key moves to its own file, everything else goes
  // into `agents secrets`.
  for (const f of rcSecretFindings(device, input.rcSecrets ?? [])) out.push(f);

  // Windows execution policy blocking the generated agents.ps1 launcher.
  const policyFinding = execPolicyFinding(device, input.execPolicy);
  if (policyFinding) out.push(policyFinding);

  // Per-version sign-in → logged-out (critical, provable) / logout-unprovable
  // (warning). Signed-in versions produce no finding — the accounts line shows
  // them. Agents that can't be inspected never yield a logout finding.
  out.push(...signInToFindings(device, input.signIn));

  return collapseAcrossVersions(out, new Set(input.isolatedVersions ?? []));
}

/**
 * Fold every orphan row on a device into one warning. Returns `[]` when nothing
 * is orphaned. Pure.
 */
function orphanFinding(device: string, rows: OrphanRow[]): DoctorFinding[] {
  const affected = rows.filter((r) => r.commands + r.skills + r.hooks > 0);
  if (affected.length === 0) return [];
  const total = affected.reduce((n, r) => n + r.commands + r.skills + r.hooks, 0);
  const where = affected.length === 1
    ? `${affected[0].agent}@${affected[0].version}`
    : `${affected.length} versions`;
  return [finding({
    severity: 'warning', kind: 'orphan', device,
    message: `${total} orphaned resource${total === 1 ? '' : 's'} on ${where} (cleanup only)`,
  })];
}

/**
 * Findings for hooks materialized into several version homes at once. Differing
 * content is CRITICAL — a stale copy can gate differently from the active one;
 * byte-identical copies are a WARNING (noise plus duplicated runtime cost).
 *
 * One row per (agent, severity), not per hook: `agents sync <agent>@<active>
 * --yes` reconciles every copy in one command, and a machine with five installed
 * claudes otherwise emits two dozen identical rows. Pure.
 */
function duplicateHookFindings(device: string, dups: DuplicateVersionHook[]): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const byAgentKind = new Map<string, DuplicateVersionHook[]>();
  for (const d of dups) {
    const key = `${d.agent} ${d.kind}`;
    if (!byAgentKind.has(key)) byAgentKind.set(key, []);
    byAgentKind.get(key)!.push(d);
  }
  for (const group of byAgentKind.values()) {
    const drift = group[0].kind === 'drift';
    const agent = group[0].agent;
    const active = group[0].authoritative.version;
    const versions = Array.from(new Set(group.flatMap((d) => d.copies.map((c) => c.version))));
    const authority = `${active} is authoritative`;
    const message = group.length === 1
      ? drift
        ? `hook '${group[0].name}' differs across ${versions.join(', ')} — ${authority}`
        : `hook '${group[0].name}' duplicated (identical) across ${versions.join(', ')} — ${authority}`
      : `${group.length} hooks ${drift ? 'differ' : 'duplicated (identical)'} across ` +
        `${versions.length} version${versions.length === 1 ? '' : 's'} ` +
        `(incl. ${group.slice(0, 2).map((d) => `'${d.name}'`).join(', ')}) — ${authority}`;
    out.push({
      severity: drift ? 'critical' : 'warning',
      kind: drift ? 'duplicate-hook-drift' : 'duplicate-hook',
      device, agent, versions, message,
      remediation: `agents sync ${agent}@all --yes`,
    });
  }
  return out;
}

/**
 * Warnings for credential-shaped exports in the user's shell rc files. The
 * file-store master passphrase and ordinary credentials have different fixes, so
 * they get one row each (never one per export — the count plus two examples
 * carries the same signal). Pure.
 */
function rcSecretFindings(device: string, rc: RcSecretFinding[]): DoctorFinding[] {
  if (rc.length === 0) return [];
  const out: DoctorFinding[] = [];
  const groups: Array<{ rows: RcSecretFinding[]; remediation: string }> = [
    {
      rows: rc.filter((f) => f.isMasterPassphrase),
      remediation: 'move it to ~/.agents/.secrets-key/passphrase (chmod 600)',
    },
    // `agents secrets add [bundle] [key]` stores exactly ONE variable
    // (`commands/secrets.ts:1349`), and nothing edits the rc file — so an
    // aggregated row has to say both that the command repeats and that the
    // deletion is manual, or following it once leaves most of the leak in place.
    { rows: rc.filter((f) => !f.isMasterPassphrase), remediation: '' },
  ];
  for (const g of groups) {
    if (g.rows.length === 0) continue;
    const n = g.rows.length;
    const examples = g.rows.slice(0, 2).map((f) => `${f.file}:${f.line} ${f.name}`).join(', ');
    const master = g.rows[0].isMasterPassphrase;
    const what = master
      ? `file-store master key exported from a shell rc file`
      : `${n} credential-shaped export${n === 1 ? '' : 's'} in shell rc files`;
    const remediation = master
      ? g.remediation
      : n === 1
        ? 'agents secrets add, then delete the rc line'
        : `agents secrets add once per export (${n}), then delete each rc line`;
    out.push({
      severity: 'warning', kind: 'rc-secret-export', device,
      message: `${what} (${examples}) — readable by any same-user process`,
      remediation,
    });
  }
  return out;
}

/**
 * The Windows-only advisory: when the effective PowerShell execution policy
 * blocks unsigned local scripts (`Restricted`/`AllSigned`), the generated
 * `agents.ps1` launcher fails even though it is on PATH. The `agents.cmd`
 * companion still works, so this is a warning and doctor never changes the
 * policy itself. Returns null off Windows or on a permissive policy — pure, so
 * both branches are testable without invoking PowerShell.
 */
function execPolicyFinding(
  device: string,
  execPolicy: LocalFindingInputs['execPolicy'],
): DoctorFinding | null {
  if (!execPolicy || execPolicy.platform !== 'win32') return null;
  if (!blocksLocalScripts(execPolicy.policy)) return null;
  return finding({
    severity: 'warning', kind: 'exec-policy', device,
    message: `PowerShell execution policy is ${execPolicy.policy} — it blocks the generated agents.ps1 launcher (agents.cmd still works)`,
  });
}

/**
 * Fold findings that say the SAME thing about several versions of one agent into
 * a single row carrying `versions`, and widen its remediation to the agent-wide
 * sweep (`agents doctor claude --fix` heals every non-isolated version in one
 * go). Five identical `plugin 'code' — mirror missing` rows, one per installed
 * claude, is the same fact five times.
 *
 * Isolated copies never merge: the agent-wide sweep deliberately skips them
 * (`runFix`), so folding one in would print a command that leaves it broken.
 * Findings with no agent (repo-behind, rc-secret-export, …) never merge either —
 * their `version` field is an alias, not a version. Pure; input order is kept.
 */
export function collapseAcrossVersions(
  findings: DoctorFinding[],
  isolated: Set<string>,
): DoctorFinding[] {
  const groups = new Map<string, DoctorFinding[]>();
  const order: string[] = [];
  for (const f of findings) {
    const mergeable = f.agent && f.version && !isolated.has(`${f.agent}@${f.version}`);
    // A non-mergeable finding gets a unique key so it passes through untouched.
    const key = mergeable
      // `account` is part of the key: two versions with the SAME problem but
      // DIFFERENT signed-in accounts are not one row — merging them would
      // attribute every version to the first member's account.
      ? `${f.device}\0${f.agent}\0${f.kind}\0${f.severity}\0${f.account ?? ''}\0${f.message}`
      : `${order.length}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(f);
  }
  const out: DoctorFinding[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) { out.push(group[0]); continue; }
    const versions = group.map((f) => f.version!);
    const merged: DoctorFinding = {
      ...group[0], version: undefined, versions, remediation: '',
    };
    merged.remediation = remediationFor(merged);
    out.push(merged);
  }
  return out;
}

/**
 * Map a device's per-version sign-in into logout findings: a PROVABLE logout is
 * CRITICAL, an unprovable one is a hedged WARNING ("could not verify sign-in"),
 * and a signed-in version yields nothing.
 *
 * An agent with no inspectable identity never appears at all — not even as the
 * hedged warning. That is the `!supportsAccountInspection` set (cursor, openclaw,
 * copilot, amp, kiro, goose, hermes): agents-cli knows no credential file for
 * them, so "logged out" is unknowable, and silence beats a false claim. The eight
 * inspectable harnesses (claude, codex, gemini, opencode, antigravity, grok,
 * kimi, droid) each have a credential path in `CREDENTIAL_FILE_SEGMENTS` and DO
 * yield a logout finding when it is genuinely absent. Pure.
 */
export function signInToFindings(
  device: string,
  signIn: Record<string, FleetVersionSignIn[]>,
): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const [agentId, rows] of Object.entries(signIn)) {
    const agent = agentId as AgentId;
    if (!supportsAccountInspection(agent)) continue;
    for (const row of rows) {
      if (row.signedIn) continue;
      if (row.provable) {
        out.push(finding({
          severity: 'critical', kind: 'logged-out', device, agent, version: row.version,
          account: row.account ?? null,
          message: 'logged out — no account signed in',
        }));
      } else {
        out.push(finding({
          severity: 'warning', kind: 'logout-unprovable', device, agent, version: row.version,
          account: row.account ?? null,
          message: 'could not verify sign-in',
        }));
      }
    }
  }
  return out;
}

/**
 * Map cross-device divergence (from {@link compareFleetInventories}) into
 * warnings: an agent version present elsewhere but absent on a device is a
 * version-skew warning; a diverged config repo is a repo-drift warning; a
 * missing resource is a missing-resource warning. Baseline = the local machine.
 * Only the *lagging* box is attributed (a `*-missing-local` finding is the
 * baseline's gap). Pure.
 */
export function fleetDivergenceToFindings(
  divergences: FleetDivergence[],
  baseline: string,
): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const d of divergences) {
    const laggingDevice = d.kind.endsWith('-missing-local') ? baseline : d.device;
    switch (d.kind) {
      case 'agent-version-missing-remote':
      case 'agent-version-missing-local':
        out.push(finding({
          severity: 'warning', kind: 'version-skew', device: laggingDevice,
          agent: d.category as AgentId, version: d.name,
          message: 'not installed (present elsewhere in the fleet)',
        }));
        break;
      case 'repo-drift':
        out.push(finding({
          severity: 'warning', kind: 'repo-drift', device: laggingDevice,
          // `category` is the repo ('agents' | 'system'); carry it as the alias
          // `agents repo pull` expects — ~/.agents is the `user` repo.
          version: d.category === 'system' ? 'system' : 'user',
          message: d.message,
        }));
        break;
      case 'resource-missing-remote':
      case 'resource-missing-local':
        out.push(finding({
          severity: 'warning', kind: 'fleet-resource-gap', device: laggingDevice,
          message: `${d.category.replace(/s$/, '')} '${d.name}' missing (present elsewhere)`,
        }));
        break;
    }
  }
  return out;
}

// ─── rendering ──────────────────────────────────────────────────────────────

/** Sort key so the worst device floats to the top: criticals, then warnings. */
function deviceSeverityRank(findings: DoctorFinding[]): number {
  const crit = findings.filter((f) => f.severity === 'critical').length;
  const warn = findings.filter((f) => f.severity === 'warning').length;
  return crit * 1000 + warn;
}

/** `claude @2.1.170` for one version, `claude (5 versions)` for a collapsed row,
 *  the bare agent id when neither applies. */
function subjectLabel(f: DoctorFinding): string {
  if (!f.agent) return '';
  if (f.versions && f.versions.length > 1) return `${f.agent} (${f.versions.length} versions)`;
  return f.version ? `${f.agent} @${f.version}` : f.agent;
}

function critLabel(f: DoctorFinding): { left: string; account: string; message: string } {
  return {
    left: subjectLabel(f),
    account: f.account ?? '',
    message: f.message,
  };
}

/** Pad a plain string to a DISPLAY width, ignoring that the caller may color it
 *  later (we pad before coloring so alignment is on visible text). Uses the
 *  repo's width helpers, not `.length`: a CJK character or a compound emoji is
 *  one-to-several UTF-16 code units but a different number of terminal columns,
 *  so `.length` skews every column in the row — and account labels, device
 *  names, and org badges are all user-supplied. */
function pad(s: string, width: number): string {
  return padToWidth(s, width);
}

/** Display width of the widest entry, floored at `min`. */
function widestOf(values: string[], min: number): number {
  return Math.max(...values.map(stringWidth), min);
}

export interface RenderOptions {
  /** Fleet mode (`--devices`): render the `─── by computer ───` header + one
   *  block per device. Single-machine mode collapses to one `▸ <machine>` block
   *  with no fleet header. */
  fleet: boolean;
  /** The baseline (local) machine name — tagged `· this machine`. */
  baseline?: string;
  /** Header line context: device count (fleet) or the local version string. */
  header?: string;
}

/**
 * Render the two-part hybrid layout from a flat findings list. Pure — returns the
 * lines so the exact output is snapshot-tested. Criticals across ALL devices go
 * to the top section, worst-first; the per-computer section lists each device's
 * warnings + a `✗ N critical (above)` marker, worst device first.
 */
export function renderFindings(
  findings: DoctorFinding[],
  accounts: Record<string, Record<string, FleetVersionSignIn[]>>,
  opts: RenderOptions,
): string[] {
  const lines: string[] = [];

  // Header.
  if (opts.header) lines.push(opts.header);
  lines.push('');

  // Group by device up front: the CRITICAL section orders its rows by the SAME
  // worst-device-first ranking the per-computer blocks use, so the two sections
  // agree and the worst machine's criticals lead.
  const byDevice = new Map<string, DoctorFinding[]>();
  for (const f of findings) {
    (byDevice.get(f.device) ?? byDevice.set(f.device, []).get(f.device)!).push(f);
  }
  // Also include devices that have accounts but no findings (a clean box still
  // needs its block + accounts line).
  for (const device of Object.keys(accounts)) {
    if (!byDevice.has(device)) byDevice.set(device, []);
  }

  const devices = Array.from(byDevice.keys()).sort((a, b) => {
    const ra = deviceSeverityRank(byDevice.get(a)!);
    const rb = deviceSeverityRank(byDevice.get(b)!);
    if (rb !== ra) return rb - ra; // worst first
    // Baseline (local) first among ties, then alphabetical.
    if (a === opts.baseline) return -1;
    if (b === opts.baseline) return 1;
    return a.localeCompare(b);
  });
  const deviceOrder = new Map(devices.map((d, i) => [d, i]));

  // ── CRITICAL section — all devices, worst device first, input order within ──
  // Array.prototype.sort is stable, so equal device ranks keep the order the
  // builders emitted — deterministic across runs.
  const criticals = findings
    .filter((f) => f.severity === 'critical')
    .sort((a, b) => (deviceOrder.get(a.device) ?? 0) - (deviceOrder.get(b.device) ?? 0));
  lines.push(`${chalk.red('✗')} ${chalk.red('CRITICAL — needs you now')}  (${criticals.length})`);
  if (criticals.length === 0) {
    lines.push(`  ${chalk.green('✓')} ${chalk.gray('nothing critical across the fleet')}`);
  } else {
    // Column widths computed on visible text.
    const rows = criticals.map((f) => ({ f, ...critLabel(f) }));
    const showDevice = opts.fleet;
    const devW = showDevice ? widestOf(rows.map((r) => r.f.device), 6) : 0;
    const leftW = widestOf(rows.map((r) => r.left), 4);
    const acctW = widestOf(rows.map((r) => r.account), 0);
    const msgW = widestOf(rows.map((r) => r.message), 4);
    for (const r of rows) {
      const dev = showDevice ? `${pad(r.f.device, devW)}  ` : '';
      const left = pad(r.left, leftW);
      const acct = acctW > 0 ? `  ${pad(r.account, acctW)}` : '';
      const msg = pad(r.message, msgW);
      lines.push(
        `  ${chalk.hex('#a3e635')(dev)}${chalk.bold(left)}${acct ? chalk.cyan(acct) : ''}  ${msg} ${chalk.blue('→')} ${chalk.blue(r.f.remediation)}`,
      );
    }
  }

  // ── by-computer section ──
  if (opts.fleet) {
    lines.push('');
    lines.push(chalk.gray('─── by computer ───'));
  }

  for (const device of devices) {
    const df = byDevice.get(device)!;
    lines.push('');
    const critN = df.filter((f) => f.severity === 'critical').length;
    const tags: string[] = [];
    if (device === opts.baseline) tags.push('this machine');
    const tagStr = tags.length ? chalk.gray(` · ${tags.join(' · ')}`) : '';
    const critMarker = critN > 0
      ? `  ${chalk.red(`✗ ${critN} critical (above)`)}`
      : '';
    lines.push(`${chalk.hex('#a3e635')(`▸ ${device}`)}${tagStr}${critMarker}`);

    // Warnings for this device.
    const warnings = df.filter((f) => f.severity === 'warning');
    if (warnings.length === 0) {
      lines.push(`    ${chalk.green('✓')} ${chalk.gray('no warnings')}`);
    } else {
      const subjW = widestOf(warnings.map(warningSubject), 4);
      for (const w of warnings) {
        const subj = pad(warningSubject(w), subjW);
        lines.push(
          `    ${chalk.yellow('⚠')} ${chalk.yellow(subj)}  ${w.message} ${chalk.blue('→')} ${chalk.blue(w.remediation)}`,
        );
      }
    }

    // Accounts / versions line for this device.
    const acctLine = renderAccountsLine(accounts[device] ?? {});
    if (acctLine) lines.push(`    ${acctLine}`);
  }

  return lines;
}

/** The left-hand subject label for a warning row (agent@version, repo alias, or
 *  a short category). */
function warningSubject(f: DoctorFinding): string {
  // Both the user and system repos live under ~/.agents — name which one, or the
  // two rows read as duplicates of each other.
  if (f.kind === 'repo-behind') return f.version ? `~/.agents (${f.version})` : '~/.agents';
  if (f.kind === 'repo-drift') return 'config repo';
  // Never "this device" — the row already sits under its own `▸ <device>` block,
  // so a self-referential subject reads as the local machine in fleet mode.
  if (f.kind === 'stale-cli') return 'agents-cli';
  if (f.kind === 'orphan') return 'orphans';
  if (f.kind === 'rc-secret-export') return 'shell rc';
  if (f.kind === 'exec-policy') return 'PowerShell';
  if (f.kind === 'fleet-resource-gap') return 'fleet gap';
  if (f.kind === 'host-cli-missing') return 'host CLIs';
  if (f.kind === 'missing-resource' && !f.agent) return 'fleet gap';
  if (f.agent) return subjectLabel(f);
  return f.kind;
}

/**
 * The compact accounts/versions line for one device: every installed version and
 * its account, grouped by agent, provable ✓ / ✗. e.g.
 *   `claude 2.1.170 ✓muqsit@gmail(Max) 2.1.999 ✓team(Team) · codex ✗ · grok ✓`
 */
export function renderAccountsLine(signIn: Record<string, FleetVersionSignIn[]>): string {
  const parts: string[] = [];
  // Stable agent order matches AGENT display order.
  const agents = Object.keys(signIn).sort((a, b) => {
    const ia = ALL_AGENT_IDS.indexOf(a as AgentId);
    const ib = ALL_AGENT_IDS.indexOf(b as AgentId);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  for (const agentId of agents) {
    const rows = signIn[agentId];
    if (!rows || rows.length === 0) continue;
    const agent = agentId as AgentId;
    if (rows.length === 1) {
      // Single version — collapse to `<agent> <badge>` (omit the version to keep
      // the healthy fleet line short), matching the target layout's `codex ✓`.
      const r = rows[0];
      parts.push(`${agentId} ${badge(agent, r)}`);
    } else {
      const versionParts = rows
        .map((r) => `${r.version} ${badge(agent, r)}`)
        .join(' ');
      parts.push(`${agentId} ${versionParts}`);
    }
  }
  return parts.join(chalk.gray(' · '));
}

/** The per-version ✓account / ✗ badge. Signed-in → green ✓ + cyan account (when
 *  known); logged-out → red ✗. */
function badge(agent: AgentId, row: FleetVersionSignIn): string {
  if (row.signedIn) {
    const who = row.account ?? '';
    return who ? `${chalk.green('✓')}${chalk.cyan(who)}` : chalk.green('✓');
  }
  return chalk.red('✗');
}
