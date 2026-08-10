- **`agents cloud run` (Rush) no longer reads the native Claude OAuth login on
  every dispatch (RUSH-2527, SING-1b).** The account manifest sent on a
  non-balanced dispatch used to include a `cred_fp` hash of each installed Claude
  version's OAuth token — computed by reading the interactive login, which the
  fleet-auth contract forbids agents-cli from touching. The manifest now carries
  **version + account email only** and reads no credential. When the server needs
  the underlying token it still asks on the **explicit, consent-gated** upload path
  (`AGENTS_RUSH_UPLOAD_TOKENS=1` / `--upload-account-tokens`), which is unchanged —
  the only path that ever reads the token, and only with recorded consent. Source:
  `apps/cli/src/lib/cloud/rush.ts` (`buildAccountManifest`). Note: rotation
  detection now relies on that consent path rather than the implicit hash; the Rush
  Cloud server side is coordinated separately.
