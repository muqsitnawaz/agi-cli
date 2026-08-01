- **No more Touch ID storm from `agents devices list`.** On macOS, the leased-boxes
  section of `agents devices list` resolved crabbox's lease and tailscale secret
  bundles through `crabboxEnv`, which picked broker-only mode from
  `isHeadlessSecretsContext()`. That auto-detect is false in a terminal, so the
  resolve was allowed to prompt — and because every keychain read spawns its own
  helper process, the Touch ID assertion is never reused and each bundle popped its
  own sheet. Any SessionStart hook that shells out to `agents devices` (the bundled
  device-topology hook does) therefore paid several biometric prompts on every new
  agent terminal. The listing path now forces `agentOnly`, so a warm bundle still
  renders, a cold one drops the section instead of grabbing the sensor, and an
  interactive `agents run --lease` keeps its one legitimate prompt.
