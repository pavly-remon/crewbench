---
name: new-task
description: Run a new task through the crewbench team (Team Lead delegates to developer, tester, code-reviewer, ui-ux-designer)
argument-hint: "[task description]"
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
Read `<root>/lib/dispatch.md` and follow it for every hand-off below: build
the lineup, align it with the user, then dispatch each role natively or
through another CLI as it describes. "Delegate to <role>" below always means
"dispatch per that protocol".

If the arguments line above is empty or still shows a placeholder, use the
text the user gave when invoking this skill.

## Workflow

1. Scope first. If the task above is underspecified (acceptance criteria,
   affected areas, edge cases), ask clarifying questions before delegating
   anything.

2. Check for a UI/UX component. If the task touches layout, components, or
   user-facing interaction, ask: "This looks like it touches UI — want the
   ui-ux role to spec it first?" Only invoke it if the user
   says yes. Never invoke it automatically.

   Then align the team lineup with the user (developer, tester,
   code-reviewer, plus ui-ux if it's being used) — one question covering
   both is fine.

3. Record the base commit (`git rev-parse HEAD`) before delegating — the
   reviewer needs it every round (dispatch.md §5). Delegate implementation
   to the developer role with a clear, scoped task description (include the
   UI/UX spec if one was produced). This is round 1.

4. Once the developer reports done, dispatch the tester and code-reviewer
   roles in parallel against the same files changed, following dispatch.md
   §5 for what to pass each of them (round 1: the diff against the base
   commit; round ≥ 2: also the previous round's issues/failures and the
   delta diff).

5. Merge their feedback per dispatch.md §5's severity threshold: if the
   tester passed and every reviewer issue is below `loop.fix_threshold`
   (and any `previous_issues` are all `resolved`), go to step 8 — list
   below-threshold issues in the final report as optional follow-ups. Wait
   for both roles to finish before deciding. Otherwise combine everything
   at or above the threshold plus all tester failures into a single fix
   list and send the developer back once — don't run two separate fix
   loops.

6. Apply dispatch.md §5's stopping rules: cap at `loop.max_rounds`, and
   stop early on oscillation (the same issue or failing test unresolved two
   rounds running). Either way, stop and summarize exactly what keeps
   failing instead of continuing to loop.

7. Never dump raw subagent output on the user. Translate to a short,
   plain-language status update.

8. Committing is yours alone — no crew role commits or pushes. Once the
   work is approved, show the user what would be committed (`git status`
   and `git diff --stat`) with a proposed commit message, and ask whether
   to commit. Only on an explicit yes, stage the task's files and commit.
   Then ask separately whether to push; push only on an explicit yes.
   If a role's result has a warning that it changed git history, tell the
   user before anything else and let them decide what to keep.
