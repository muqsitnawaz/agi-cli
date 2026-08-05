- **Muse Code (Meta) harness support.** `muse` is a first-class agent: install via
  `curl -fsSL https://dev.meta.ai/install.sh | sh`, run with `agents run muse`,
  and use in teams. Modes map to Muse safety flags (`--disable-write` /
  `--disable-approval` / `--yolo`); `--model` and `--reasoning-effort` are
  forwarded; headless is `muse exec` with `--json`; interactive resume is
  `muse resume <id>` (id immediately after the verb), headless resume is
  `--session-id`. Sessions under `~/.local/share/muse/sessions/` (plus version
  homes) are discovered and parsed; usage shows Meta Model API rate limits when
  a key is present, otherwise local 7-day token totals. MCP writes to
  `~/.config/muse/settings.json` (`mcp_servers`, `schema_version: 1`). Model
  catalog: `muse-spark-1.2` (default), `1.1`, `1.2-contributor` with offline
  pricing. Aliases: `muse-code`, `meta-muse`. Hooks write Claude-shaped
  matcher groups into `~/.config/muse/settings.json` (`schema_version: 1`);
  plugins use the Claude marketplace layout under the XDG data plugin store
  (`~/.local/share/muse/plugins`) with `.muse-plugin` manifests. Allowlist
  stays false (Muse uses approval-mode + sandbox, not tool-name allow/deny).
  Source: `apps/cli/src/lib/{agents,exec,models,usage,mcp,hooks,plugins,
  plugin-marketplace,runner,shims}.ts`, `apps/cli/src/lib/session/*`.
