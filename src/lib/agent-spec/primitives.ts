// Pure version primitives for the agent-spec engine — zero dependencies, so the
// whole module (and versions.ts, which re-uses these) stays trivially testable.

/**
 * The only shape a version string may take before it reaches an exec/shim/path
 * boundary. Accepts the literal `latest` or a 1–64 char run of `[A-Za-z0-9._+-]`
 * with no `..` traversal. This is THE validation gate — every resolver funnels
 * exact-version tokens through it.
 */
export const VERSION_RE = /^(?:latest|(?!.*\.\.)[A-Za-z0-9._+-]{1,64})$/;

/** Canonical qualifier set, in help/display order. `pinned` ≡ `default`. */
export const AGENT_QUALIFIERS = ['latest', 'oldest', 'pinned', 'default', 'all'] as const;
export type AgentQualifier = (typeof AGENT_QUALIFIERS)[number];

/**
 * Record-filter-only qualifiers. `any` means "no version constraint" for
 * historical-record queries (sessions/teams resume) — accepted by the filter
 * path but intentionally kept out of the display vocabulary.
 */
export const RECORD_ONLY_QUALIFIERS = ['any'] as const;

/** Split a version into numeric `.`-segments (non-numeric tail → 0), e.g. `2026.2.19-2` → [2026,2,19]. */
function numericParts(v: string): number[] {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}

/**
 * Trailing `-<digits>` build suffix as a number (0 when absent). OpenClaw ships
 * same-day rebuilds as `2026.2.19-2` where a higher `-N` is NEWER — the opposite
 * of a semver pre-release. Used only to break exact numeric ties, so semver-style
 * versions (which carry no `-N`) are unaffected.
 */
function buildSuffix(v: string): number {
  const m = /-(\d+)$/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Total, deterministic ordering for version strings (ascending).
 *   1. numeric segment comparison (semver-ish: `2.1.187` > `2.1.143`)
 *   2. tie → trailing `-N` build suffix, numerically (`2026.2.19-2` > `2026.2.19`)
 *   3. tie → raw-string compare, so `listInstalledVersions` is never order-unstable
 *
 * Deliberately NOT a full semver comparator: OpenClaw's `-N` is a rebuild marker
 * (higher = newer); a semver comparator would invert it.
 */
export function compareVersions(a: string, b: string): number {
  const na = numericParts(a);
  const nb = numericParts(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const av = na[i] || 0;
    const bv = nb[i] || 0;
    if (av !== bv) return av - bv;
  }
  const sa = buildSuffix(a);
  const sb = buildSuffix(b);
  if (sa !== sb) return sa - sb;
  return a < b ? -1 : a > b ? 1 : 0;
}
