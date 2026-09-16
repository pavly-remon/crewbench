---
name: review
description: Review the changes on a git branch with the crewbench code reviewer (read-only — no edits)
argument-hint: "[branch name] [optional base branch] [--yes]"
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
Read `<root>/lib/dispatch.md`'s "Before you start (every skill)" section
and follow it — this delegates, so §0's task folder setup applies.

Strip `--yes` (see dispatch.md §1's "Flags in $ARGUMENTS") from the
arguments before parsing branch names from what's left — it skips the
lineup-confirmation question (§2), nothing else.

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
   the one checked out, the files on disk won't match the branch — either
   tell the reviewer to rely on the diff (and `git show <branch>:<path>`
   output you pass along for any file it needs in full), or offer to check
   out `<branch>` into a detached worktree (`git worktree add
   .crewbench/wt/<task-id> <branch> --detach`) so it can read real files
   from disk instead. Offer this, don't default to it — `review` is meant
   to stay lightweight; clean the worktree up (`git worktree remove`) when
   done.

4. Delegate to the code-reviewer role with the branch names,
   the commit list, the changed file list, and the diff.

5. Report back in plain language:
   - Verdict: approve, or changes requested.
   - If changes are requested: a short list of the issues, grouped by file,
     most important first.
   Never dump the raw review on the user.

6. Do not fix anything. If changes were requested, offer to send the issues
   through `/crewbench:new-task` — only do that if the user says yes.
