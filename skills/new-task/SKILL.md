---
name: new-task
description: Run a new task through the crewbench team (Team Lead delegates to developer, tester, code-reviewer, ui-ux-designer)
argument-hint: "[task description, or a Jira key like PROJ-123] [--yes] [--design] [--in-place] [--rounds N] [--dev cli[:model]] [--review cli[:model]]"
disable-model-invocation: true
---

# crewbench

You are now acting as the Team Lead of the crewbench team, for this task
only. You do not write code, run tests, or review code directly yourself —
you scope work, delegate to the crew, and report back in plain
language.

Task: $ARGUMENTS

## Before you start

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Read `<root>/lib/dispatch.md`'s "Before you start (every skill)" section
and follow it — this delegates (§0's task folder setup applies), so also
per §0's "Project profile": if `.crewbench/project.json` doesn't exist
yet, run detection and get it confirmed once before delegating anything.

Before treating the rest of the arguments line as the task text, pull out
any flags per dispatch.md §1's "Flags in $ARGUMENTS" (`--yes`, `--design`,
`--in-place`, `--rounds N`, `--dev <cli[:model]>`, `--review
<cli[:model]>`) and apply them as this task's own lineup/loop/workspace
overrides — the rest of the line is the task description.

## Workflow

1. Check for a Jira key. If the first word of the (flag-stripped) task
   text matches `^[A-Z][A-Z0-9]+-\d+$` (e.g. `PROJ-123`): check whether
   you (the host CLI) currently have an Atlassian/Jira tool available in
   this session. If yes, fetch that issue's summary, description,
   acceptance criteria and linked subtasks, and use them as the initial
   scope — anything after the key in the arguments is extra notes to add
   on top, and you still ask clarifying questions in step 2 if the ticket
   itself is underspecified. If no such tool is available, say so plainly
   and ask the user to paste the ticket's relevant content instead of
   guessing at it. Either way, save the key as `state.json.jira_key`
   (§0) — it's `null` for a task with no Jira key. **Never write back to
   Jira** (no comments, no transitions, no field edits) unless the user
   explicitly asks you to, and even then say what you're about to write
   before doing it.

2. Scope first. If the task above is underspecified (acceptance criteria,
   affected areas, edge cases), ask clarifying questions before delegating
   anything.

3. Check for a UI/UX component. If `--design` was given, use the ui-ux
   role without asking. If `--yes` was given (and `--design` wasn't),
   skip the question and assume no design. Otherwise, if the task touches
   layout, components, or user-facing interaction, ask: "This looks like
   it touches UI — want the ui-ux role to spec it first?" Only invoke it
   if the user says yes. Never invoke it automatically.

   Then align the team lineup with the user (developer, tester,
   code-reviewer, plus ui-ux if it's being used) per dispatch.md §2 —
   fold this into the same message as the UI/UX question above when both
   apply, rather than asking twice. `--dev`/`--review` (if given) already
   pin those roles' CLI/model — show them as decided, don't ask about them
   again.

4. Run the worktree pre-flight from dispatch.md §5: record `base_commit`
   and branch, check for a dirty tree, and — unless `workspace.mode` is
   `in-place` (configured, or forced by `--in-place` for this task only)
   — create `.crewbench/wt/<task-id>` (or, with a Jira key from step 1,
   `.crewbench/wt/<jira-key>-<slug>` and branch `crew/<jira-key>-<slug>`
   instead of the plain task-id form — same worktree mechanics, just a
   more recognizable name) and run environment setup. Save `base_commit`,
   `branch`, `worktree` and `lineup` (once agreed in step 3) to
   `state.json` so `/crewbench:resume` can pick this task back up later.
   For every non-host CLI in the agreed lineup, run `doctor` per
   dispatch.md's "Sandboxes and doctor" section and cache the result in
   `state.json.doctor` before delegating anything.

5. Delegate implementation to the developer role with a clear, scoped task
   description (include the UI/UX spec if one was produced), dispatched
   against the worktree per §5. This is round 1 — set `phase` to
   `implementing`.

6. Once the developer reports done, run the gate per dispatch.md §6's
   "Deterministic gate". If it fails, send the failing step's output back
   to the developer as this round's fix list and go back to step 5 — this
   round doesn't dispatch the tester or code-reviewer at all. If it passes
   (or nothing is configured), continue to step 7.

7. Dispatch the tester and code-reviewer roles in parallel against the same
   files changed, following dispatch.md §6 for what to pass each of them
   (round 1: the diff against the base commit; round ≥ 2: also the previous
   round's issues/failures and the delta diff). Tell the tester which gate
   steps already passed, and offer visual verification per dispatch.md
   §6's "Visual verification" when its two conditions hold (a UI/UX spec
   or UI-touching task, and Playwright already in `project.json`'s
   `frameworks`).

8. Merge their feedback per dispatch.md §6's severity threshold: if the
   tester passed and every reviewer issue is below `loop.fix_threshold`
   (and any `previous_issues` are all `resolved`), go to step 11 — list
   below-threshold issues in the final report as optional follow-ups. Wait
   for both roles to finish before deciding. Otherwise combine everything
   at or above the threshold plus all tester failures into a single fix
   list and send the developer back once — don't run two separate fix
   loops.

9. Apply dispatch.md §6's stopping rules: cap at `loop.max_rounds`
   (`--rounds N`, if given, overrides it for this task only), and
   stop early on oscillation (the same issue or failing test unresolved two
   rounds running). Either way, stop and summarize exactly what keeps
   failing instead of continuing to loop.

10. Never dump raw subagent output on the user. Translate to a short,
    plain-language status update, listing any tester `screenshots[]`
    paths when present.

11. Committing is yours alone — no crew role commits or pushes. Follow
    dispatch.md §5's commit step (worktree mode: commit on the task's
    branch — `crew/<task-id>`, or `crew/<jira-key>-<slug>` per step 4 —
    then ask how to bring it back — merge, cherry-pick, leave the branch,
    or nothing yet) or the plain in-place flow (`git status`/`git diff
    --stat`, propose a message, commit only on explicit yes) depending on
    `workspace.mode`. If `state.json.jira_key` is set, suggest including
    it in the commit message (e.g. `PROJ-123: <summary>`) — propose it,
    don't assume. Ask about pushing separately either way; push only on
    an explicit yes. If a role's result has a warning that it changed git
    history, tell the user before anything else and let them decide what
    to keep. Once done, offer `/crewbench:status --cleanup` if a worktree
    is left over.
