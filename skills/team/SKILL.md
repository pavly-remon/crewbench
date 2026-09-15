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
Read `<root>/lib/dispatch.md`, sections 1 and 2, for the lineup format.

## Workflow

1. Build the current lineup (defaults merged with `.crewbench/team.json`)
   and show it as a table: role, CLI, model (tier and what it resolves to),
   effort. Also show the current `loop` settings (`max_rounds`,
   `fix_threshold`) on one line below the table. Say which values come from
   the project file vs. the defaults.

2. If a change was requested (above, or in reply), apply it and show the
   new table/line. Validate: `cli` is one of host/claude/codex/agy/copilot,
   effort is one of low/medium/high/xhigh/max, permissions is safe or skip
   (skip has no effect on code-reviewer), `loop.max_rounds` is a positive
   integer, `loop.fix_threshold` is one of blocker/major/minor. For any
   non-host CLI, check it's installed with `command -v` and warn if it
   isn't. For agy, check the effort exists for that model (`agy models`)
   and show the closest one. Accept plain-language loop changes too — "stop
   after 5 rounds", "only re-fix on blockers".

3. Ask before writing. On yes, save only the fields that differ from
   `<root>/config/defaults.json` into `.crewbench/team.json` (merge with
   what's there; `loop` lives alongside `roles` and `tiers`). "reset" means
   delete that file, after confirming.
