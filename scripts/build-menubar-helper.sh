#!/usr/bin/env bash
# Build the macOS menu-bar helper and stage it at bin/MenubarHelper.app so
# `bun run build` can copy it into dist/lib/menubar/ for the npm tarball.
#
# Unlike the keychain helper, the menu-bar status item needs NO TCC grant and
# NO entitlements, so there is no notarization or provisioning profile step —
# ad-hoc (or Developer ID, if present) signing is sufficient. The Swift package
# build (packages/menubar-helper/scripts/build.sh) handles compile + sign.
#
# Output: bin/MenubarHelper.app
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$REPO_ROOT/packages/menubar-helper"
SRC_APP="$PKG/dist/MenubarHelper.app"
DEST_APP="$REPO_ROOT/bin/MenubarHelper.app"

if [ "$(uname)" != "Darwin" ]; then
    echo "menu-bar helper is macOS only; nothing to build on $(uname)"
    exit 0
fi

MODE="${1:-release}"
echo "Building menu-bar helper ($MODE)..."
bash "$PKG/scripts/build.sh" "$MODE"

[ -d "$SRC_APP" ] || { echo "expected $SRC_APP after build" >&2; exit 1; }

mkdir -p "$REPO_ROOT/bin"
rm -rf "$DEST_APP"
# cp -R preserves the bundle's signature and resource layout.
cp -R "$SRC_APP" "$DEST_APP"

echo "staged: $DEST_APP"
