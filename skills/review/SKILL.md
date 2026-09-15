---
name: review
description: Review the changes on a git branch with the crewbench code reviewer (read-only — no edits)
argument-hint: "[branch name] [optional base branch]"
disable-model-invocation: true
---

# crewbench: review

You are now acting as the Team Lead of the crewbench team, for this task
only. You do not review or edit code yourself — you gather the changes,
delegate to the code-reviewer role, and report back in plain
language.

Arguments: $ARGUMENTS

## Before you start

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Read `<root>/lib/dispatch.md` and follow it for every hand-off below: build
the lineup, align it with the user, then dispatch each role natively or
through another CLI as it describes. "Delegate to <role>" below always means
"dispatch per that protocol".

Set up the task folder per dispatch.md §0 before anything else: compute the
task id, create `.crewbench/tasks/<task-id>/state.json`, and make sure
`.crewbench/tasks/` and `.crewbench/wt/` are in `.git/info/exclude`. Update
`state.json`'s `phase` as you move through the steps below.

If the arguments line above is empty or still shows a placeholder, use the
text the user gave when invoking this skill.

## Workflow

1. Work out what to compare.
   - Branch to review: the first argument. If none was given, ask which
     branch (suggest the current branch from `git branch --show-current`).
   - Base branch: the second argument if given; otherwise the repository's
     default branch (`git symbolic-ref refs/remotes/origin/HEAD`, falling
     back to `main` or `master`, whichever exists).
   - Confirm both branches exist (`git rev-parse --verify`). If one
     doesn't, say so and stop — don't guess a different branch.

2. Gather the changes. The reviewer is read-only and cannot run git, so
   collect this for it:
   - `git log --oneline <base>...<branch>` — the commits being reviewed.
   - `git diff --stat <base>...<branch>` — the files changed.
   - `git diff <base>...<branch>` — the full diff.
   Only run read-only git commands. Never check out, reset, commit, or push.
   If there are no changes between the branches, say so and stop.

3. Make the changed files readable. If the branch being reviewed is not
   the one checked out, the files on disk won't match the branch — tell the
   reviewer to rely on the diff (and `git show <branch>:<path>` output you
   pass along for any file it needs in full) rather than reading those files
   from disk.

4. Delegate to the code-reviewer role with the branch names,
   the commit list, the changed file list, and the diff.

5. Report back in plain language:
   - Verdict: approve, or changes requested.
   - If changes are requested: a short list of the issues, grouped by file,
     most important first.
   Never dump the raw review on the user.

6. Do not fix anything. If changes were requested, offer to send the issues
   through `/crewbench:new-task` — only do that if the user says yes.
