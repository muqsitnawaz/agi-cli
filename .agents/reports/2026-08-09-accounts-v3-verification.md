# Unified accounts verification

Audience: agents-cli maintainers and users reviewing RUSH-2470.

## What changed

Provider accounts are now one-to-one `agents secrets` bundles. Native OAuth identities remain in harness-owned version homes. The account catalog presents provider bundles and local native identities as separate sections, while `--fleet` uses the existing stable native-identity aggregation across devices.

Each provider bundle contains `ACCOUNT_ID`, `PROVIDER`, `AUTH_TYPE`, optional `BASE_URL`, and either `API_KEY` or `TOKEN`. Its policy is always `never`. `--account` overrides a configured per-harness default; without either, the existing native/balanced selection remains in control.

## Automated results

Final test output and installed-CLI screenshots are recorded below after verification. No credential values are included in this report.

## Security result

- Provider values remain inside the configured secrets backend.
- Account bundle metadata is safe to enumerate; values are stored separately.
- Account bundles use `policy: never`, which writes macOS values without a biometry ACL.
- Linux workers use the encrypted file backend with a machine-local key; Windows uses Credential Manager.
- Native OAuth credentials are discovered only; account sync does not copy them.
