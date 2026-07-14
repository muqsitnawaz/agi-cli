#!/usr/bin/env bash
set -euo pipefail
cd /Users/muqsit/src/github.com/muqsitnawaz/agents-cli/.agents/sign-host-1.20.60/apps/cli
# Unlock the signing keychain headless, then inject the Apple notary creds.
security unlock-keychain -p "$(cat "$HOME/Library/Application Support/rush/signing.kcpass")" rush-signing.keychain-db
export AGENTS_SECRETS_PASSPHRASE="$(cat "$HOME/Library/Application Support/rush/secrets.pass")"
agents secrets exec apple.com -- bash -c '
  set -euo pipefail
  echo "== menu-bar helper: swift build + codesign =="
  menubar/scripts/build.sh release
  # rm -rf first so a re-run does not nest the new .app INSIDE a stale
  # bin/MenubarHelper.app (cp -R into an existing dir), which corrupts the
  # signature ("unsealed contents present in the bundle root").
  rm -rf bin/MenubarHelper.app
  cp -R menubar/dist/MenubarHelper.app bin/MenubarHelper.app
  codesign --verify --deep --strict "bin/MenubarHelper.app"
  echo "== keychain helper: swiftc + codesign + notarize =="
  scripts/build-keychain-helper.sh
  echo "== pin sha256 of the notarized keychain binary =="
  shasum -a 256 "bin/Agents CLI.app/Contents/MacOS/Agents CLI" > "scripts/Agents CLI.app.sha256"
  cat "scripts/Agents CLI.app.sha256"
  echo "== standalone agents binary: bun build + codesign + notarize =="
  bun install --frozen-lockfile
  scripts/sign-cli-binary.sh
'
