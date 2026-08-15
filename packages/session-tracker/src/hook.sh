#!/usr/bin/env bash
# Polyglot SessionStart hook.
#
# Registered in each agent's native config file — either by this package's
# install-hook.ts (dev/standalone, passes the agent as $1) or by agents-cli's
# built-in hook registration (apps/cli/src/lib/hooks.ts, which registers the
# script bare: manifest hook commands carry no arguments, so the script
# self-identifies the harness from its parent process).
#
# Each agent passes the hook payload differently:
#   - claude/codex/cursor: JSON on stdin with session_id (+conversation_id for cursor)
#   - grok: GROK_SESSION_ID and GROK_WORKSPACE_ROOT env vars
#   - hermes: JSON on stdin (on_session_start payload); best-effort field probe
#   - anything else: best-effort stdin probe (a miss writes nothing, never wrong)
#
# Writes ~/.agents/.cache/terminals/sessions/<PPID>.json with the canonical
# SessionState schema from src/types.ts. Atomic via mktemp + mv; a temp that
# never reaches mv is removed by the EXIT trap. After a successful write it
# prunes the state dir: dead-pid state files and orphaned atomic-write temps.
#
# Invocation:
#   hook.sh [<agent>]          # optional; selects which payload format to parse
#
# Silent on success (SessionStart stdout leaks into the model context).

set -euo pipefail

AGENT="${1:-${AGENT_HINT:-}}"

# Read stdin if any (don't block forever).
# Use `cat` only when stdin is not a TTY — and rely on hosts (claude, codex,
# cursor) closing stdin promptly. macOS has no `timeout` in PATH by default,
# so we don't use it.
STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON="$(cat || true)"
fi

# Self-identify when invoked bare: the hook process's parent IS the harness
# ($PPID — same invariant the state file's key relies on below). Prefer the
# grok env marker, then map the parent's command line to a known harness id,
# skipping one interpreter frame (node/bun/python shebang launchers).
if [ -z "$AGENT" ]; then
  if [ -n "${GROK_SESSION_ID:-}" ]; then
    AGENT="grok"
  else
    PARENT_CMD="$(ps -o command= -p "$PPID" 2>/dev/null || true)"
    ARG0="${PARENT_CMD%% *}"
    BASE="${ARG0##*/}"
    case "$BASE" in
      node*|bun*|python*|deno*)
        REST="${PARENT_CMD#* }"
        ARG1="${REST%% *}"
        BASE="${ARG1##*/}"
        ;;
    esac
    case "$BASE" in
      claude*)   AGENT="claude" ;;
      codex*)    AGENT="codex" ;;
      cursor*)   AGENT="cursor" ;;
      kimi*)     AGENT="kimi" ;;
      droid*)    AGENT="droid" ;;
      grok*)     AGENT="grok" ;;
      hermes*)   AGENT="hermes" ;;
      gemini*)   AGENT="gemini" ;;
      opencode*) AGENT="opencode" ;;
      goose*)    AGENT="goose" ;;
      kiro*)     AGENT="kiro" ;;
      copilot*)  AGENT="copilot" ;;
      muse*)     AGENT="muse" ;;
      *)         AGENT="unknown" ;;
    esac
  fi
fi

SID=""
CWD=""
METHOD="hook-stdin"

extract_stdin_json() {
  local field_priority="$1"  # space-separated list of JSON keys to try in order
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    for k in '''$field_priority'''.split():
        v = d.get(k)
        if isinstance(v, str) and v:
            print(v); sys.exit(0)
        if isinstance(v, list) and v and isinstance(v[0], str):
            print(v[0]); sys.exit(0)
except Exception:
    pass
" 2>/dev/null || true
}

case "$AGENT" in
  claude|codex|droid|kimi)
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd')"
    ;;
  cursor)
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id conversation_id')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd workspace_roots')"
    ;;
  grok)
    SID="${GROK_SESSION_ID:-}"
    CWD="${GROK_WORKSPACE_ROOT:-$PWD}"
    METHOD="hook-env"
    ;;
  *)
    # hermes/gemini/antigravity/unknown/future harnesses: best-effort stdin-JSON
    # probe across the field names these harnesses use. A miss exits 0 below
    # (no state file) — never a wrong write.
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id conversation_id sessionId')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd workspace_roots')"
    ;;
esac

if [ -z "$SID" ]; then
  exit 0
fi

# The session id becomes two filenames below. Reject path components before
# either mktemp or mv sees the harness-provided value.
case "$SID" in
  *'/'*|*'\'*|'.'|'..') exit 0 ;;
esac

[ -z "$CWD" ] && CWD="$PWD"

STATE_DIR="$HOME/.agents/.cache/terminals/sessions"
mkdir -p "$STATE_DIR"

TID="${AGENT_TERMINAL_ID:-}"
LID="${AGENT_LAUNCH_ID:-}"

# Under `set -e` a failed writer aborts the script between mktemp and mv,
# stranding the temp (the .<pid>.XXXXXX orphans this trap exists to prevent).
TMP=""
SID_TMP=""
trap 'rm -f ${TMP:+"$TMP"} ${SID_TMP:+"$SID_TMP"} 2>/dev/null || true' EXIT

TMP="$(mktemp "$STATE_DIR/.${PPID}.XXXXXX")"
python3 - "$SID" "$CWD" "$PPID" "$AGENT" "$TID" "$LID" "$METHOD" > "$TMP" <<'PY'
import json, sys, time
sid, cwd, pid, agent, tid, lid, method = sys.argv[1:8]
out = {
    "session_id": sid,
    "agent": agent,
    "cwd": cwd,
    "pid": int(pid),
    "ts": int(time.time() * 1000),
    "method": method,
}
if tid:
    out["terminal_id"] = tid
if lid:
    out["launch_id"] = lid
json.dump(out, sys.stdout)
PY

# A zero-byte temp means the writer produced nothing — never promote it to a
# state file the readers would have to reject.
[ -s "$TMP" ] || exit 0

mv -f "$TMP" "$STATE_DIR/$PPID.json"
TMP=""

# Prune the state dir: state files whose pid is gone (ESRCH only — an EPERM
# pid exists under another uid and is left alone, mirroring
# pruneStaleSessionState in src/reader.ts) and dot-prefixed atomic-write temps
# older than an hour (orphans from a writer that died before mv).
python3 - "$STATE_DIR" <<'PY' 2>/dev/null || true
import os, re, sys, time
state_dir = sys.argv[1]
now = time.time()
try:
    names = os.listdir(state_dir)
except OSError:
    sys.exit(0)
for name in names:
    p = os.path.join(state_dir, name)
    m = re.fullmatch(r'(\d+)\.json', name)
    if m:
        try:
            os.kill(int(m.group(1)), 0)
        except ProcessLookupError:
            try:
                os.unlink(p)
            except OSError:
                pass
        except (PermissionError, OverflowError, ValueError):
            pass
        continue
    if name.startswith('.'):
        try:
            if now - os.stat(p).st_mtime > 3600:
                os.unlink(p)
        except OSError:
            pass
PY

# Persist launch metadata under the harness's real session id. `agents run`
# exports the EFFECTIVE mode after capability/headless resolution, plus the
# shared (non-version-home) history directory. Atomic replacement lets a native
# resume with an explicit --mode become the new mode for the next resume.
HISTORY_DIR="${AGENTS_HISTORY_DIR:-}"
RUN_MODE="${AGENTS_RUN_MODE:-}"
TMUX_SESSION_NAME="${AGENT_TMUX_SESSION_NAME:-}"
if [ -n "$HISTORY_DIR" ] && { [ -n "$RUN_MODE" ] || [ -n "$TMUX_SESSION_NAME" ]; }; then
  BY_SESSION_DIR="$HISTORY_DIR/by-session"
  mkdir -p "$BY_SESSION_DIR"
  SID_TMP="$(mktemp "$BY_SESSION_DIR/.${SID}.XXXXXX")"
  python3 - "$SID" "$RUN_MODE" "${AGENTS_ACTOR:-}" "${AGENTS_ACTOR_KIND:-}" "$TMUX_SESSION_NAME" "$BY_SESSION_DIR/$SID.json" > "$SID_TMP" <<'PY'
import json, re, sys, time
sid, mode, actor, initiated_by, tmux_name, existing_path = sys.argv[1:7]
out = {}
try:
    with open(existing_path) as existing:
        value = json.load(existing)
        if isinstance(value, dict):
            out = value
except (OSError, ValueError):
    pass
out['sessionId'] = sid
if mode in ('plan', 'edit', 'auto', 'skip'):
    out['mode'] = mode
out['startedAtMs'] = int(time.time() * 1000)
if actor:
    out['actor'] = actor
if initiated_by in ('human', 'agent'):
    out['initiatedBy'] = initiated_by
if re.fullmatch(r'ag-[a-z][a-z0-9-]*-[0-9a-f]{8}', tmux_name, re.I):
    aliases = out.get('aliases')
    if not isinstance(aliases, list):
        aliases = []
    aliases = [alias.lower() for alias in aliases if isinstance(alias, str) and re.fullmatch(r'ag-[a-z][a-z0-9-]*-[0-9a-f]{8}', alias, re.I)]
    aliases.append(tmux_name.lower())
    out['aliases'] = list(dict.fromkeys(aliases))
json.dump(out, sys.stdout)
PY
  [ -s "$SID_TMP" ] || exit 0
  mv -f "$SID_TMP" "$BY_SESSION_DIR/$SID.json"
  SID_TMP=""
fi
exit 0
