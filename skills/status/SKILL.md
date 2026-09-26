---
name: status
description: Show recent crewbench tasks, or the full status of one task (phase, lineup, rounds, running/finished runs, resume commands). Read-only.
argument-hint: "[task-id]"
disable-model-invocation: true
---

# crewbench: status

You report on crewbench task state. You never delegate to a crew role, run
the dispatch script for a new run, or change any file except (for the
`--cleanup` case below) removing a finished worktree or a finished task's
own directory, each only after the user confirms that specific one.

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

   Also run `python3 <root>/bin/crewbench_daemon_probe.py` (Phase 4
   milestone 5) — a plain, unauthenticated liveness probe against the
   crewbench app's daemon, the same one `/crewbench:open`'s own docstring
   explains in full (never the token-gated API, never anything more than
   "is a daemon here"). If its `"found"` is `true`, mention it plainly at
   the top of your report: "running in crewbench ui at `<url>`" — this is
   informational only, it doesn't change anything else about this report,
   and its absence (`"found": false`) means nothing is running, not that
   anything is wrong.

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

   Then, separately, run `python3 <root>/bin/crewbench_state.py
   cleanup-candidates` (default: finished tasks whose `updated_at` is 30+
   days old; pass `--older-than-days N` if the user names a different
   threshold) and show the list — id, title, phase, age in days. This is
   a listing only; it never deletes anything by itself. For each task the
   user explicitly confirms, run `python3 <root>/bin/crewbench_state.py
   delete --task-dir .crewbench/tasks/<task-id>` — this permanently
   removes that task's entire directory (every round's logs, results,
   `events.jsonl`, `state.json`) and its `index.json` entry; there is no
   undo. The command itself refuses (and changes nothing) if the task's
   real, current phase isn't done/stopped/failed, in case it was resumed
   since this list was generated — if it refuses, say so and move on to
   the next task rather than treating it as an error. Ask before each
   deletion individually; never batch-confirm "delete all of these."

4. Never dump raw JSON on the user — translate into a short, readable
   summary. If the task id doesn't exist, say so plainly.
