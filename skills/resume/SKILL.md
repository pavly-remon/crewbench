---
name: resume
description: Resume an interrupted crewbench task from its saved state, without re-asking the lineup.
argument-hint: "[task-id]"
disable-model-invocation: true
---

# crewbench: resume

You are the Team Lead resuming a previously started task. Reload its state
instead of starting over, and don't re-ask anything already settled.

Argument: $ARGUMENTS

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Before anything else, run `python3 <root>/bin/crewbench_banner.py` and show
its output verbatim.
Read `<root>/lib/dispatch.md` and follow it for every hand-off from here on
(the resumed task already has its own folder — skip §0's setup, you're
reloading it, not creating it).

## Workflow

1. Pick the task. With a task id, use it. Without one, read
   `python3 <root>/bin/crewbench_state.py list` and offer the most recent
   task whose `phase` is not `done`/`stopped`/`failed`. If there isn't one,
   say so and stop — don't guess.

2. Load `python3 <root>/bin/crewbench_state.py get --task-dir
   .crewbench/tasks/<task-id>` and `<task-dir>/runs/status.json`. Summarize
   where it stopped in 3–5 lines: task title, phase, round, last thing that
   happened.

3. Reconcile run state: for any run in `status.json` marked `running`,
   check whether its `pid` is still alive. If it's dead, treat that run as
   `failed` (update `status.json` for that run) rather than waiting on it
   forever.

4. Check the working tree still matches what the task last left it in:
   - In-place tasks: compare the current `git diff --stat` against what the
     last round's snapshot implies (e.g. files the developer reported
     changed should still show as changed, unless the task reached
     `awaiting_commit`/`done`).
   - Worktree tasks (Phase 5): confirm `.crewbench/wt/<task-id>` still
     exists and is on `branch`.
   If anything looks different from what the state file implies (files
   reverted, worktree missing, branch changed), tell the user exactly what
   changed and ask how to proceed — don't assume and don't silently
   overwrite anything.

5. Continue from the current `phase` using the lineup already stored in
   `state.json.lineup` — do not re-ask the lineup question. Pick up
   wherever that phase's workflow left off (e.g. `fixing` → resume the fix
   loop at the recorded `round`; `awaiting_commit` → re-show the diff and
   ask about committing).

6. From here on, follow the same workflow as the task's original command
   (`new-task`, `test`, `review` or `design` — from `state.json.command`)
   for everything after the resume point.
