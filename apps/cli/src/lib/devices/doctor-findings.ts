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
import { loginHint } from '../signin-badge.js';
import type { AgentId } from '../types.js';
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
  | 'never-synced'        // installed but never synced (WARNING)
  | 'stale'               // sources changed since last sync (WARNING)
  | 'repo-behind'         // a config repo behind origin (WARNING)
  | 'repo-drift'          // a config repo diverged from the fleet baseline (WARNING)
  | 'version-skew'        // an agent version present elsewhere, absent here (WARNING)
  | 'orphan'              // orphan resources in a version home (WARNING)
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
  /** Version id, when about a specific installed version. */
  version?: string;
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
      // Isolated per-version home: point native login at THIS version.
      return `agents run ${idLabel}, then ${native}`;
    }
    case 'missing-hook':
    case 'missing-plugin':
    case 'unwired-hook':
    case 'missing-resource':
    case 'content-drift':
    case 'stale':
      return idLabel ? `agents doctor ${idLabel} --fix` : 'agents doctor --fix';
    case 'never-synced':
      return idLabel ? `agents sync ${idLabel} --yes` : 'agents sync';
    case 'cli-missing':
      return agent ? `agents add ${agent}` : 'agents add <agent>';
    case 'orphan':
      return 'agents prune cleanup';
    case 'repo-behind':
      return `agents repo pull ${finding.version ?? 'user'}`;
    case 'repo-drift':
      return 'agents repo pull user';
    case 'version-skew':
      return idLabel ? `agents add ${idLabel}` : 'agents add <agent>@<version>';
    case 'stale-cli':
      return 'upgrade';
  }
}

function finding(f: Omit<DoctorFinding, 'remediation'>): DoctorFinding {
  return { ...f, remediation: remediationFor({ ...f, remediation: '' }) };
}

/**
 * Emit findings for a list of same-kind resource names on ONE version: name the
 * first two individually (so a small gap is precise), then collapse the tail into
 * a single `+N more <noun>s <verb>` line so a version missing dozens doesn't flood
 * the section. `noun` is the collapse-line noun (hook / plugin / resource).
 * `preNamed` items already carry their full descriptor in the string (e.g.
 * `command 'audit' missing`, `skill 'x' changed upstream — re-sync`), so they pass
 * through unwrapped; otherwise `n` is a bare name and is wrapped as
 * `<noun> '<n>' missing`.
 */
function emitCollapsed(
  out: DoctorFinding[],
  names: string[],
  severity: FindingSeverity,
  kind: FindingKind,
  device: string,
  agent: AgentId,
  version: string,
  noun: string,
  preNamed = false,
): void {
  if (names.length === 0) return;
  const NAMED = 2;
  const named = names.slice(0, NAMED);
  const rest = names.length - named.length;
  for (const n of named) {
    // For missing items `n` is the bare name → wrap it; for content-drift the
    // caller already built the full descriptor, so pass it through.
    const message = preNamed ? n : `${noun} '${n}' missing`;
    out.push(finding({ severity, kind, device, agent, version, message }));
  }
  if (rest > 0) {
    const verb = kind === 'content-drift' ? 'drifted' : 'missing';
    out.push(finding({
      severity, kind, device, agent, version,
      message: `+${rest} more ${noun}${rest === 1 ? '' : 's'} ${verb}`,
    }));
  }
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

    const missingHooks: string[] = [];
    const missingPlugins: string[] = [];
    const missingOther: string[] = [];
    const drifted: string[] = [];
    for (const kind of ['commands', 'skills', 'hooks', 'rules', 'mcp', 'permissions', 'subagents', 'plugins', 'promptcuts'] as const) {
      for (const r of report.kinds[kind] ?? []) {
        if (r.status === 'missing') {
          if (kind === 'hooks') missingHooks.push(r.name);
          else if (kind === 'plugins') missingPlugins.push(r.name);
          else missingOther.push(`${kind.replace(/s$/, '')} '${r.name}' missing`);
        } else if (r.status === 'diff') {
          drifted.push(
            r.detail
              ? `${kind.replace(/s$/, '')} '${r.name}' — ${r.detail}`
              : `${kind.replace(/s$/, '')} '${r.name}' changed upstream — re-sync`,
          );
        }
      }
    }

    if (neverSynced) {
      // Everything is "missing" because it was never synced — one line.
      const total = missingHooks.length + missingPlugins.length + missingOther.length;
      if (total > 0) {
        out.push(finding({
          severity: 'critical', kind: 'unwired-hook', device, agent, version,
          message: `never synced — ${total} resource${total === 1 ? '' : 's'} (incl. ${missingHooks.length} hook${missingHooks.length === 1 ? '' : 's'}, ${missingPlugins.length} plugin${missingPlugins.length === 1 ? '' : 's'}) not installed`,
        }));
      }
    } else {
      // Synced-but-drifted: name a few missing hooks/plugins, collapse the rest.
      emitCollapsed(out, missingHooks, 'critical', 'missing-hook', device, agent, version, 'hook');
      emitCollapsed(out, missingPlugins, 'critical', 'missing-plugin', device, agent, version, 'plugin');
      emitCollapsed(out, missingOther, 'warning', 'missing-resource', device, agent, version, 'resource', true);
      emitCollapsed(out, drifted, 'warning', 'content-drift', device, agent, version, 'resource', true);
    }
  }

  // Sync status → stale (warning). A NEVER-SYNCED version already surfaced a
  // single collapsed critical above (its resources aren't installed at all), so
  // we don't ALSO emit a never-synced warning — that would double-report the same
  // root cause. A stale version whose drift is only content (files present but
  // changed) is a genuine standalone warning.
  for (const row of input.syncRows) {
    if (row.status === 'stale') {
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

  // Orphans (warning).
  for (const row of input.orphanRows) {
    const parts: string[] = [];
    if (row.commands) parts.push(`${row.commands} command${row.commands === 1 ? '' : 's'}`);
    if (row.skills) parts.push(`${row.skills} skill${row.skills === 1 ? '' : 's'}`);
    if (row.hooks) parts.push(`${row.hooks} hook${row.hooks === 1 ? '' : 's'}`);
    out.push(finding({
      severity: 'warning', kind: 'orphan', device, agent: row.agent, version: row.version,
      message: `${parts.join(', ')} orphaned (cleanup only)`,
    }));
  }

  // Per-version sign-in → logged-out (critical, provable) / logout-unprovable
  // (warning). Signed-in versions produce no finding — the accounts line shows
  // them. Agents that can't be inspected never yield a logout finding.
  out.push(...signInToFindings(device, input.signIn));

  return out;
}

/**
 * Map a device's per-version sign-in into logout findings: a PROVABLE logout is
 * CRITICAL, an unprovable one is a hedged WARNING ("could not verify sign-in"),
 * and a signed-in version yields nothing. An agent with no inspectable identity
 * never appears (its rows are never provable and we skip the hedge too — a
 * cursor/antigravity "logout" is meaningless). Pure.
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
          message: d.message,
        }));
        break;
      case 'resource-missing-remote':
      case 'resource-missing-local':
        out.push(finding({
          severity: 'warning', kind: 'missing-resource', device: laggingDevice,
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

function critLabel(f: DoctorFinding): { left: string; account: string; message: string } {
  const idLabel = f.agent && f.version
    ? `${f.agent} @${f.version}`
    : f.agent ?? '';
  return {
    left: idLabel,
    account: f.account ?? '',
    message: f.message,
  };
}

/** Pad a plain string to a width, ignoring that the caller may color it later
 *  (we pad BEFORE coloring so alignment is on visible text). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
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

  // ── CRITICAL section — all devices, worst-first (device order stable) ──
  const criticals = findings.filter((f) => f.severity === 'critical');
  lines.push(`${chalk.red('✗')} ${chalk.red('CRITICAL — needs you now')}  (${criticals.length})`);
  if (criticals.length === 0) {
    lines.push(`  ${chalk.green('✓')} ${chalk.gray('nothing critical across the fleet')}`);
  } else {
    // Column widths computed on visible text.
    const rows = criticals.map((f) => ({ f, ...critLabel(f) }));
    const showDevice = opts.fleet;
    const devW = showDevice ? Math.max(...rows.map((r) => r.f.device.length), 6) : 0;
    const leftW = Math.max(...rows.map((r) => r.left.length), 4);
    const acctW = Math.max(...rows.map((r) => r.account.length), 0);
    const msgW = Math.max(...rows.map((r) => r.message.length), 4);
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
      const subjW = Math.max(...warnings.map((w) => warningSubject(w).length), 4);
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
  if (f.kind === 'repo-behind') return '~/.agents';
  if (f.kind === 'repo-drift') return 'config repo';
  if (f.kind === 'stale-cli') return 'this device';
  if (f.kind === 'missing-resource' && !f.agent) return 'fleet gap';
  if (f.agent && f.version) return `${f.agent} @${f.version}`;
  if (f.agent) return f.agent;
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
