- **The VS Code extension is now AGI EXT; its dashboard is Fleet.** `apps/factory`
  moved to `apps/ext` — the component is a thin UI wrapper over the CLI, not a
  factory. The webview tab and navbar read **AGI EXT**, and the agent-status
  dashboard formerly called "Factory Floor" is now **Fleet**. A dashboard tab
  restored from a pre-rename build is reclaimed rather than left beside the new
  one. Marketplace identity is unchanged (publisher `swarmify`, name `swarm-ext`),
  so installs and the `swarm-ext://` URI keep working. Unrelated same-name
  surfaces are untouched: Factory.ai/droid (`~/.factory`, `FACTORY_API_KEY`, the
  `factory` cloud provider), the beta-gated `agents factory` Software Factory
  command, and Rush Cloud's own Factory Floor.
