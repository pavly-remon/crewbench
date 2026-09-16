---
name: team
description: Show or change the crewbench team lineup — which CLI, model and effort each role (developer, tester, code-reviewer, ui-ux) uses
argument-hint: "[optional change, e.g. 'reviewer on codex, high effort']"
disable-model-invocation: true
---

# crewbench: team

You are the Team Lead of the crewbench team. This skill only manages the
team lineup — it never runs a task.

Requested change: $ARGUMENTS

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Read `<root>/lib/dispatch.md`'s §1 and §2 for the lineup format (this skill
doesn't delegate, so the rest of its "Before you start (every skill)"
section doesn't apply here).

## Workflow

1. Build the current lineup (defaults merged with `.crewbench/team.json`)
   and show it as a table: role, CLI, model (tier and what it resolves to),
   effort. Also show the current `loop` settings (`max_rounds`,
   `fix_threshold`), `workspace` settings (`mode`, `setup`), and
   `confirm_lineup` (`always`/`when_unsaved`/`never`) on one or two lines
   below the table. Say which values come from the project file vs. the
   defaults.

   Then check the "`skip` launch friction on a Claude Code host" note in
   dispatch.md's Commits section: if you're running as `claude` and
   `~/.claude/settings.json` doesn't already allow-list dispatch calls,
   show the exact line to add and what it permits, once. Skip this check
   entirely on any other host.

2. If a change was requested (above, or in reply), apply it and show the
   new table/lines. Validate: `cli` is one of host/claude/codex/agy/copilot,
   effort is one of low/medium/high/xhigh/max, permissions is safe or skip
   (skip has no effect on code-reviewer), `loop.max_rounds` is a positive
   integer, `loop.fix_threshold` is one of blocker/major/minor,
   `workspace.mode` is `worktree` or `in-place`, `confirm_lineup` is
   always/when_unsaved/never. For any non-host CLI,
   check it's installed with `command -v` and warn if it isn't. Accept
   plain-language changes too — "stop after 5 rounds", "only re-fix on
   blockers", "work in-place, no worktrees".

   **Model name freshness:** for each resolved model, run `python3
   <root>/bin/crewbench_env.py check-model --cli <cli> --model <model>`.
   When `checked` is `true` and `found` is `false`, tell the user the
   model isn't in that CLI's current list, show `closest`, and offer to
   override `tiers.<cli>` in `.crewbench/team.json` with the closest match
   (only on yes). When `checked` is `false` (`claude`, `codex` and
   `copilot` — no model-listing command was found for any of the three as
   of writing, `agy models` is the only one that exists), skip silently;
   don't claim a model was verified when it wasn't.

   **Copilot `safe` tester:** if the lineup has `tester` on `copilot`
   headlessly with `permissions: safe`, warn that Copilot denies shell in
   `safe` mode, so a headless Copilot tester can't run tests at all — it
   can only report what it would have run. Suggest `permissions: skip`,
   a different CLI for `tester`, or relying on the Phase 7 gate
   (`.crewbench/project.json`'s commands) to actually run tests
   deterministically instead.

   If the lineup mixes a native-route role (Claude Code or Copilot on
   host) with `workspace.mode: worktree`, mention the trade-off from
   dispatch.md §3: a native subagent can't be given its own working
   directory the way a headless dispatch can, so isolation there is
   best-effort (the role is told the worktree path, not confined to it).

   For any role whose CLI differs from the current host (run
   `python3 <root>/bin/crewbench_env.py whoami` once to know `host`), check
   `<root>/docs/compatibility.md` for that host x role-CLI cell. If it's
   marked `partial` or `unsupported`, say so plainly (with the cell's
   caveat) before showing the final table — don't silently accept it. This
   is a heads-up, not a block: proceed if the user still wants that
   combination.

3. Ask before writing. On yes, save only the fields that differ from
   `<root>/config/defaults.json` into `.crewbench/team.json` (merge with
   what's there; `loop`, `workspace` and `confirm_lineup` live alongside
   `roles` and `tiers`). "reset" means delete that file, after confirming.
