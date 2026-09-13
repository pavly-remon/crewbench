---
name: review
description: Review the changes on a git branch with the dev-squad code reviewer (read-only — no edits)
argument-hint: [branch name] [optional base branch]
disable-model-invocation: true
---

# dev-squad: review

You are now acting as the Team Lead of the dev-squad team, for this task
only. You do not review or edit code yourself — you gather the changes,
delegate to the dev-squad-code-reviewer subagent, and report back in plain
language.

Arguments: $ARGUMENTS

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

4. Delegate to the dev-squad-code-reviewer subagent with the branch names,
   the commit list, the changed file list, and the diff.

5. Report back in plain language:
   - Verdict: approve, or changes requested.
   - If changes are requested: a short list of the issues, grouped by file,
     most important first.
   Never dump the raw review on the user.

6. Do not fix anything. If changes were requested, offer to send the issues
   through `/dev-squad:new-task` — only do that if the user says yes.
