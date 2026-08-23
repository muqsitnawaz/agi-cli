---
type: feat
---

`agents sessions trace` (single-session HTML/text) is rebuilt around an
**analysis hero** and a **step-ordered trajectory**, replacing the wall-clock
Gantt waterfall. The new HTML/text lead with "where the time went" (a stacked
tool-time bar), the slowest steps, a tool-mix histogram that breaks a Bash step
down by its **effective shell program** (`git`, `gh`, `bun`, …) instead of
lumping every shell call as "Bash", and headline KPIs (errors, idle total,
longest gap) — followed by the trajectory in execution order: one row per
step badged by its program/tool, duration heat-colored, the process **exit
code** shown on a failing step, runs of ≥3 fast same-program calls folded into
one expander, and idle gaps rendered as centered `··· idle 3m ···` dividers
rather than a time axis. The compare and lineage views pick up the same
program-aware badges and exit codes. `TrajectoryStep` gains `program?` and
`exitCode?`, derived by reusing the real bash parser behind
`tool-calls.ts`/`shell-programs.ts` — never a naive command-prefix split.
Source: `apps/cli/src/lib/session/{trajectory,trajectory-html,trajectory-text}.ts`.
