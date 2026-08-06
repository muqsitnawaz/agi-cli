# Resource Inventory & Inspect Specification

## Purpose

agents-cli materializes DotAgents resources (hooks, skills, commands, plugins, MCP, rules, workflows, subagents) from layered repos into per-agent version homes, registers them in each harness’s native config so the runtime can fire them, and exposes inventory via `agents inspect` / `agents view` / `agents doctor`. This specification defines the **source-of-truth contract** for that inventory surface: what “installed,” “wired,” and “capable” mean, how they must be reported, and how install/sync must keep those three states coherent across every hooks-capable agent—not only the Claude settings.json family.

Boundary: declaration → resolve → write to version home → register native config → inspect/report. Out of scope: harness-internal hook execution engines (Claude Code / Grok / Kimi runtimes), except for the CLI’s obligation to write the formats those engines document.

## Requirements

### Requirement: Capability vs inventory are distinct
The system SHALL treat “agent can use hooks/skills/…” (capability) as orthogonal to “this version home has those resources on disk” (inventory) and “the harness config references them so they fire” (wiring).

#### Scenario: Grok reports hooks capability with empty inspect list
- GIVEN agent `grok` has `supportsHooks: true` / `capabilities.hooks: true` in the agent table
- WHEN the operator runs `agents inspect grok`
- THEN the Capabilities section MAY show hooks as supported
- AND the Resources/Hooks section SHALL NOT imply zero capability merely because the inventory list is empty
- AND if inventory is empty while wiring files contain managed hook commands, that SHALL be reportable as drift (not “unsupported”)

Evidence: `apps/cli/src/lib/agents.ts` grok `supportsHooks: true`; `apps/cli/src/lib/hooks.ts:711` SETTINGS_JSON_HOOK_FAMILY only `claude|droid` for wiring checks; live: `agents inspect grok` shows `hooks ✓` and `Hooks (0)`.

---

### Requirement: Filesystem inventory is the installed-resource truth
The system SHALL derive “what is installed for an agent version” by scanning that version’s home filesystem (and project overlay), not solely by reading `agents.yaml` tracking tables.

#### Scenario: getAgentResources scans the home
- GIVEN a version home path for agent A
- WHEN `getAgentResources(A, { home })` runs
- THEN commands, skills, hooks, mcp, memory, and workflows lists SHALL be populated from installed-on-disk helpers (`listInstalled*WithScope`)
- AND the module comment SHALL document filesystem as source of truth

Evidence: `apps/cli/src/lib/resources.ts:274-280` (“source of truth - not the tracking data in agents.yaml”); hooks loop `listInstalledHooksWithScope` at `resources.ts:348-354`.

---

### Requirement: Version hooks directory path is resolvable
The system SHALL resolve `getVersionHooksDir(agent, version)` to a path that exists whenever that version home was successfully synced with hooks, for every agent whose `supportsHooks` is true—including agents whose `hooksDir` is configured as an absolute path under `$HOME`.

#### Scenario: Absolute hooksDir does not corrupt path.join
- GIVEN `AGENTS.grok.hooksDir` is `path.join(HOME, '.grok', 'hooks')` (absolute)
- AND a version home exists at `…/versions/grok/<ver>/home`
- WHEN `getVersionHooksDir('grok', ver)` is computed as `path.join(home, agentConfigDirName(agent), AGENTS[agent].hooksDir)`
- THEN the result SHALL be the version-local hooks directory `…/home/.grok/hooks` (or an equivalent existing path)
- AND it SHALL NOT produce a non-existent hybrid path that embeds the absolute hooksDir as a relative segment under the version home

Evidence (current drift): `hooks.ts:689-691` join formula; `agents.ts` grok `hooksDir: path.join(HOME, '.grok', 'hooks')`; live Node produces `…/home/.grok/Users/…/.grok/hooks` which `exists: false`, so `listHooksInVersionHome('grok',…)` returns `[]` while `listHookEntriesFromDir('…/home/.grok/hooks')` returns 40+ names.

---

### Requirement: Hook file discovery includes nested event layout
The system SHALL discover hook scripts under a version hooks root including nested event subdirectories introduced by the hooks layout (e.g. `pre-tool-use/`, `stop/`, `session-start/`), not only top-level files.

#### Scenario: Nested stop hook is listed
- GIVEN `…/.grok/hooks/stop/00-agent-verify-work-complete.sh` exists
- WHEN inventory lists hooks for that root via `listHookEntriesFromDir`
- THEN an entry named `00-agent-verify-work-complete` (or equivalent stable name) SHALL appear
- AND pure documentation/data files without a script extension SHALL NOT be treated as hooks

Evidence: dist `listHookEntriesFromDir` uses `collectHookFilesFromRoot` and prefers top-level on basename collision; source `hooks.ts:436-494` historically top-level-only (verify version under test). Live relative scan returns nested names including `00-agent-verify-work-complete`, `git-guard`, etc.

---

### Requirement: Manifest resolution is layered and separate from registration
The system SHALL resolve hook *declarations* from DotAgents layers (system / user / project) with higher layers winning on name, and SHALL NOT treat declaration sync as equivalent to harness registration.

#### Scenario: HooksHandler.sync does not register
- GIVEN `HooksHandler.sync` is invoked
- WHEN the call returns
- THEN no requirement is made that settings.json / hooks.json / config.toml were updated
- AND registration remains the responsibility of `registerHooksToSettings`

Evidence: `apps/cli/src/lib/resources/hooks.ts:154-161` (“no-op placeholder… registration is a separate concern”).

---

### Requirement: Sync writes files and registers native config for hooks-capable agents
When hooks are written into a version home for a hooks-capable agent that the CLI supports for registration, the system SHALL invoke `registerHooksToSettings` so the harness native config references the managed hook commands.

#### Scenario: Writer registers after copy
- GIVEN agent is one of claude, codex, antigravity, kimi, droid, copilot, kiro, goose, cursor, grok, hermes
- WHEN the hooks resource writer finishes copying selected hooks into `{versionHome}/{configDir}/hooks`
- THEN it SHALL call `registerHooksToSettings(agent, versionHome)`

Evidence: `apps/cli/src/lib/staleness/writers/hooks.ts:89-96`; dispatcher branches `hooks.ts:1486-1514` (claude, droid, codex, antigravity, grok, kimi, …).

---

### Requirement: Registration formats are harness-specific
The system SHALL register hooks using each harness’s documented config format:

- Claude / Droid: `settings.json` event → matcher groups → command hooks
- Grok: `hooks/hooks.json` (Claude-compatible event map under `hooks`)
- Kimi: `config.toml` `[[hooks]]` array with `event` + `command`
- Codex / Cursor / others: their respective registrars under `registerHooksToSettings`

#### Scenario: Grok registration targets hooks.json
- GIVEN `registerHooksForGrok` runs for a version home
- WHEN registration succeeds
- THEN `versionHome/.grok/hooks/hooks.json` SHALL contain a `hooks` object keyed by lifecycle events with command entries

Evidence: `hooks.ts:2298-2308` (`grokHooksDir`, writes under `.grok/hooks`); live zion: 38 commands in `~/.grok/hooks/hooks.json`.

#### Scenario: Kimi registration targets config.toml
- GIVEN `registerHooksForKimi` runs
- THEN `versionHome/.kimi-code/config.toml` SHALL contain managed `[[hooks]]` entries with `event` and `command`

Evidence: `hooks.ts:2437-2446` (`configPath` … `config.toml`); live: 38 `[[hooks]]` blocks.

---

### Requirement: Wiring verification covers every registered harness family
The system SHALL provide a read-only wiring check that, for each agent family `registerHooksToSettings` can write, verifies managed hook commands appear in that family’s native config—not only for the Claude/Droid settings.json family.

#### Scenario: Unsupported family is not silently “ok”
- GIVEN agent is `grok` or `kimi` or `codex`
- WHEN `checkVersionHookWiring(agent, version)` runs under today’s code
- THEN the report’s `supported` field SHALL be false for unsupported families OR the implementation SHALL be extended so `supported` is true and `unwired` is accurate
- AND doctor/inspect consumers SHALL NOT treat `supported: false` as “all hooks wired”

Evidence (current drift): `hooks.ts:711` `SETTINGS_JSON_HOOK_FAMILY = ['claude', 'droid']`; `checkVersionHookWiring` early-return `{ supported: false, unwired: [] }` at `756-758`; comment `703-709` explicitly excludes other harnesses.

---

### Requirement: Inspect reports inventory that matches getAgentResources
`agents inspect <agent[@version]>` SHALL list hooks (and other kinds) using the same inventory source as `getAgentResources` for that version home, so a successful sync is visible in inspect without manual path probing.

#### Scenario: After sync, inspect hook count is non-zero when files and wiring exist
- GIVEN hooks scripts exist under the real version hooks root and native config lists managed commands
- WHEN `agents inspect grok` / `agents inspect kimi` runs
- THEN Hooks total SHALL be greater than zero (or an explicit “wired N / on-disk M” breakdown)
- AND SHALL NOT print `Hooks (0)` solely because `getVersionHooksDir` joined an absolute `hooksDir` incorrectly

Evidence (current drift): live `listInstalledHooksWithScope('grok')` → `[]` while relative dir scan lists 40+ scripts and `hooks.json` has 38 commands; `inspect.ts:959-961` uses `getAgentResources` → `listInstalledHooksWithScope`.

---

### Requirement: Inspect distinguishes on-disk vs wired vs unmanaged
The system SHOULD present, for hooks at minimum, three counts or sets:

1. **On-disk** — scripts under the version hooks tree  
2. **Wired (managed)** — commands in native config that agents-cli manages (central/shim/version prefixes)  
3. **Unmanaged** — native config hooks not owned by agents-cli  

#### Scenario: Operator diagnoses “sync worked but inspect empty”
- GIVEN on-disk hooks exist and wiring file has 38 managed commands
- WHEN inspect runs in detail/JSON mode
- THEN the operator can see on-disk ≥ 1 and wired ≥ 1 without opening files by hand

Evidence: partial building blocks exist (`checkVersionHookWiring`, `listUnmanagedHooksInVersionHome`, doctor hook wiring) but are not unified into inspect’s summary for all agents (`inspect.ts` hook rows use file list + central manifest events only).

---

### Requirement: Central manifest supplies event metadata for known hooks
When displaying a hook that appears in the DotAgents hook manifest, inspect SHALL attach declared events/matcher/matches/cache from that manifest (not invent them).

#### Scenario: Manifest-backed summary line
- GIVEN hook name `git-guard` is in the parsed central/user/system manifest with events PreToolUse
- WHEN inspect expands Hooks
- THEN the row MAY show those events via `hookManifestByScript` / `summarizeHook`

Evidence: `inspect.ts:663`, `722`, `1055+`; manifest load `loadCentralHookManifest` / `hookManifestByScript`.

---

### Requirement: Single inventory engine is the chokepoint
The system SHALL expose one library API (conceptually “resource inventory”) that install, sync, refresh, inspect, view --merged, and doctor all use for:

- available (declared in layers)  
- installed (on disk in version home)  
- wired (native config, where applicable)  
- capable (agent+version feature flags)

Callers SHALL NOT reimplement path join / format parsing per command for the same kind.

#### Scenario: Inspect and doctor agree on installed hooks for claude
- GIVEN the same agent@version
- WHEN inspect and doctor both report installed hooks
- THEN they SHALL use the same list/count source for on-disk hooks

Evidence (current partial): `getAgentResources` is shared; doctor uses additional `diffHooks` / `checkVersionHookWiring`; path bugs in `getVersionHooksDir` affect every consumer of that helper (`hooks.ts:689-691`).

---

## Drift findings (requirement vs code as of agents-cli 1.22.x / zion)

| # | Requirement theme | Status | Anchors |
|---|-------------------|--------|---------|
| D1 | Absolute `hooksDir` path resolution | **DRIFT** — `getVersionHooksDir` / `listInstalledHooksWithScope` build non-existent paths for grok/kimi; inspect shows Hooks (0) | `hooks.ts:689-691`, `hooks.ts:638-644`, `agents.ts` absolute hooksDir |
| D2 | Wiring check multi-harness | **DRIFT** — only claude\|droid supported | `hooks.ts:711`, `756-758` |
| D3 | Inspect shows wiring | **DRIFT** — inspect is file inventory + manifest events, not native config parse for grok/kimi/codex | `inspect.ts:959-961` |
| D4 | Filesystem as truth | **SATISFIED** (intent) | `resources.ts:274-280` |
| D5 | Registration on write for many agents | **SATISFIED** | `writers/hooks.ts:95-96`, `registerHooksToSettings` branches |
| D6 | HooksHandler.sync no-op | **SATISFIED** (by design) | `resources/hooks.ts:154-161` |
| D7 | Nested hook layout discovery | **PARTIAL** — dist walks nested; broken path short-circuits before list | dist `collectHookFilesFromRoot` vs bad `getVersionHooksDir` |
| D8 | Live Grok/Kimi wiring works | **SATISFIED outside inspect** — hooks.json / config.toml have 38 cmds, all paths exist | live probe 2026-08-05 |

## Coverage gaps & ambiguities

- Whether `path.join` absolute-segment reset is intentionally bypassed by storing “absolute” hooksDir strings that are not absolute on all platforms (needs unit test; live Node on macOS produced hybrid paths).
- Orphan purge policy after resource removal (sync additive) is adjacent but not fully specified here—inventory engine SHOULD expose “declared but not installed” and “installed but not declared.”
- Plugin marketplace copies vs top-level skills install paths for the same name.

## Relationship to change

Fixing inspect/path join and unifying on-disk vs wired reporting is a **delta** for `/swarm:plan` (or a normal PR) against this spec—especially D1–D3. This document is the *is + required contract*, not the task list.
