#!/bin/bash
#
# Regression tests for install.sh and build.sh
# Exercises the two bugs from RUSH-1584:
#   1. build.sh must install ui/ dependencies (not just root node_modules)
#   2. install.sh must resolve activate.sh absolutely (works from any cwd)
#
# Runs against the real scripts with real file checks — no mocks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_ROOT/../.." && pwd)"
FAILURES=0

fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS: $1"; }

# ---------------------------------------------------------------------------
# Test 1: build.sh installs ui/node_modules when missing
# ---------------------------------------------------------------------------
# Verify the build script text includes the ui/node_modules install block.
# A clean worktree has no ui/node_modules; the script must handle that.
if grep -q 'ui/node_modules' "$SCRIPT_DIR/build.sh"; then
    pass "build.sh checks for ui/node_modules"
else
    fail "build.sh does not check for ui/node_modules — clean worktree build will fail"
fi

# Stronger: verify the block actually runs bun install in the ui dir
if grep -qE '\(cd ui && bun install\)|cd ui.*bun install' "$SCRIPT_DIR/build.sh"; then
    pass "build.sh runs bun install inside ui/"
else
    fail "build.sh does not install ui/ dependencies"
fi

# ---------------------------------------------------------------------------
# Test 2: install.sh resolves activate.sh with an absolute path
# ---------------------------------------------------------------------------
# The bug: dirname of BASH_SOURCE[0] is relative to the *original* cwd,
# but install.sh has already cd'd to PROJECT_ROOT. Using the relative dirname
# after the cd gives a wrong path when invoked from repo root.

# Extract the activate.sh invocation line
ACTIVATE_LINE="$(grep 'activate\.sh' "$SCRIPT_DIR/install.sh" | grep -v '^#')"

if echo "$ACTIVATE_LINE" | grep -qF '$(dirname "${BASH_SOURCE[0]}")'; then
    fail "install.sh still uses relative dirname for activate.sh — breaks when invoked from repo root"
elif echo "$ACTIVATE_LINE" | grep -qF '$PROJECT_ROOT/scripts/activate.sh'; then
    pass "install.sh resolves activate.sh via absolute PROJECT_ROOT"
elif echo "$ACTIVATE_LINE" | grep -qF '"$PROJECT_ROOT/scripts/activate.sh"'; then
    pass "install.sh resolves activate.sh via absolute PROJECT_ROOT (quoted)"
else
    fail "install.sh activate.sh path is not clearly absolute — may break from different cwd"
fi

# ---------------------------------------------------------------------------
# Test 3: activate.sh exists where install.sh expects it
# ---------------------------------------------------------------------------
if [ -f "$PROJECT_ROOT/scripts/activate.sh" ]; then
    pass "activate.sh exists at PROJECT_ROOT/scripts/activate.sh"
else
    fail "activate.sh missing at $PROJECT_ROOT/scripts/activate.sh"
fi

# ---------------------------------------------------------------------------
# Test 4: ui/package.json exists (build.sh depends on it)
# ---------------------------------------------------------------------------
if [ -f "$PROJECT_ROOT/ui/package.json" ]; then
    pass "ui/package.json exists"
else
    fail "ui/package.json missing — ui dependency install would fail"
fi

# ---------------------------------------------------------------------------
# Test 5: Simulate repo-root invocation path resolution
# ---------------------------------------------------------------------------
# When invoked as `bash apps/factory/scripts/install.sh 1.0.0` from repo root,
# BASH_SOURCE[0] = "apps/factory/scripts/install.sh", dirname = "apps/factory/scripts".
# After cd to PROJECT_ROOT (abs path to apps/factory/), the old dirname-based path
# "apps/factory/scripts/activate.sh" resolves to apps/factory/apps/factory/scripts/activate.sh
# which doesn't exist. The fix uses $PROJECT_ROOT/scripts/activate.sh instead.

SIMULATED_OLD_PATH="$PROJECT_ROOT/apps/factory/scripts/activate.sh"
SIMULATED_NEW_PATH="$PROJECT_ROOT/scripts/activate.sh"

if [ -f "$SIMULATED_OLD_PATH" ]; then
    fail "old relative path accidentally resolves (test premise broken)"
else
    pass "old relative dirname path does NOT resolve from PROJECT_ROOT cwd (confirms the bug)"
fi

if [ -f "$SIMULATED_NEW_PATH" ]; then
    pass "new absolute path resolves correctly from PROJECT_ROOT"
else
    fail "new absolute path does not resolve — fix is wrong"
fi

# ---------------------------------------------------------------------------
echo
if [ "$FAILURES" -gt 0 ]; then
    echo "$FAILURES test(s) FAILED"
    exit 1
else
    echo "All tests passed"
fi
