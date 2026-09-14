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
   effort. Say which values come from the project file vs. the defaults.

2. If a change was requested (above, or in reply), apply it and show the
   new table. Validate: `cli` is one of host/claude/codex/agy/copilot,
   effort is one of low/medium/high/xhigh/max, permissions is safe or skip
   (skip has no effect on code-reviewer). For any non-host CLI, check
   it's installed with `command -v` and warn if it isn't. For agy, check the
   effort exists for that model (`agy models`) and show the closest one.

3. Ask before writing. On yes, save only the fields that differ from
   `<root>/config/defaults.json` into `.crewbench/team.json` (merge with
   what's there). "reset" means delete that file, after confirming.
