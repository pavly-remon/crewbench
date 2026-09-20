---
name: status
description: Show recent crewbench tasks, or the full status of one task (phase, lineup, rounds, running/finished runs, resume commands). Read-only.
argument-hint: "[task-id]"
disable-model-invocation: true
---

# crewbench: status

You report on crewbench task state. You never delegate to a crew role, run
the dispatch script for a new run, or change any file except (for the
`--cleanup` case below) removing a finished worktree the user confirms.

Argument: $ARGUMENTS

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Before anything else, run `python3 <root>/bin/crewbench_banner.py` and show
its output verbatim.

## Workflow

1. No argument (or the placeholder wasn't replaced): read
   `.crewbench/index.json` (`python3 <root>/bin/crewbench_state.py list`)
   and show a compact table: id, title, phase, round, updated. Newest
   first. If it's empty or missing, say there are no tasks yet.

2. With a task id: read
   `python3 <root>/bin/crewbench_state.py get --task-dir
   .crewbench/tasks/<task-id>` and `<task-dir>/runs/status.json`. Report:
   - Phase, round, lineup (per role: CLI, model, effort, permissions).
   - Each round's verdicts and open issue ids (from `state.json.rounds`).
   - Runs currently marked `running` in `status.json` — check whether their
     `pid` is still alive (e.g. `kill -0 <pid>` on POSIX; treat an error as
     dead, note if you can't check on the current platform); call out any
     that are dead but still marked `running` (a crashed or killed process)
     without changing the file yourself — that's `/crewbench:resume`'s job.
   - Log paths and, for finished runs, the `resume_command` from each
     run's `.result.json`.
   - Any `notes` recorded on the task.
   - The usage summary from `state.json.usage`, in the same one-line-per-
     role-plus-total format as dispatch.md §7's "Usage summary" (omit
     roles with zero runs; omit cost/tokens where they're `null`).

3. `--cleanup` (with or without a task id): list finished tasks (`phase`
   in done/stopped/failed) that still have a worktree at
   `.crewbench/wt/<task-id>` (dispatch.md §5). For each, ask before
   removing it (`git worktree remove`) and deleting its branch. Also run
   `git worktree prune` for any worktree directories that were deleted by
   hand outside git. Do nothing without per-task confirmation.

4. Never dump raw JSON on the user — translate into a short, readable
   summary. If the task id doesn't exist, say so plainly.
