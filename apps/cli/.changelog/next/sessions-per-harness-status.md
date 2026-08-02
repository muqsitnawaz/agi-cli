- **`agents sessions` now shows an accurate working / waiting / idle status for
  every harness, and shows it as text in the default list — not just a glyph.** Two
  gaps are closed. (1) A live non-Claude/Codex agent (grok, droid, gemini, rush,
  kimi, hermes, opencode, antigravity) used to fall through to a blanket `unknown`
  because `findSessionFileForKind` / `computeLiveSignals` only resolved and parsed
  Claude and Codex transcripts — a running Codex or grok session displayed
  `unknown`. Every tracked harness whose transcript is locatable + parseable is now
  wired into the same state engine: `findSessionFileForKind` resolves each kind's
  transcript through the session index (`latestSessionFileForCwd`), and
  `computeLiveSignals` parses it with that harness's own parser and runs it through
  the same `inferSessionState`, so it gets a real `working` / `waiting_input` /
  `idle` the principled way Claude/Codex do. For a genuinely opaque kind (cursor) or
  an unreadable transcript, `resolveFallbackStatus` now reports `running` for any
  live process — **a running agent never displays `unknown`** (that state is reserved
  for the sole un-answerable case: a dead process whose transcript vanished
  mid-read), and a live process is never downgraded to a fabricated `idle`. (2) The
  default `agents sessions` list (flat, tree, and the project overview) showed only a
  colored glyph for live rows; it now also prints the status **word** —
  `working` / `waiting` / `idle` — next to the glyph, the same three states the
  `--active` column shows, with `waiting` the unmistakable "needs you" case. The
  single-session preview (`agents sessions <id> --preview`) leads with the same live
  status line, flagging `← needs you` when the agent is waiting on a question,
  permission, or plan review. Source: `apps/cli/src/lib/session/active.ts`
  (`findSessionFileForKind`, `computeLiveSignals`, `resolveFallbackStatus`),
  `apps/cli/src/commands/sessions.ts` (`liveStatusWord`, `flatSessionRow`,
  `treeSessionRow`, `renderSessionPreview`).
