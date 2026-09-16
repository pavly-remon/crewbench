---
name: profile
description: Show, refresh, or edit the project profile (.crewbench/project.json and project.md) crewbench uses for the gate and every role hand-off
argument-hint: "[show|refresh|edit <change>]"
disable-model-invocation: true
---

# crewbench: profile

You manage the project profile — never a task. This skill only reads,
proposes, or (on confirmation) writes `.crewbench/project.json` and
`.crewbench/project.md`.

Argument: $ARGUMENTS (default: `show`)

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Read `<root>/lib/dispatch.md`'s "Project profile" section (in §0) and
`<root>/schemas/project.json` for the field reference.

## Workflow

1. **`show`** (default, or no argument): if `.crewbench/project.json`
   exists, print it compactly — package manager, install command, each
   configured `commands` entry, languages, frameworks, source dirs,
   `confirmed`/`detected_at` — followed by `.crewbench/project.md`'s
   contents if it exists. If `project.json` is missing, say so and suggest
   `/crewbench:profile refresh`.

2. **`refresh`**: run `python3 <root>/bin/crewbench_profile.py detect --cwd .`
   and show the proposal next to the existing `project.json` (if any),
   highlighting anything that differs. Ask the user to confirm each field or
   correct it — one compact message, not one question per field. Only after
   they confirm, write `.crewbench/project.json` with `confirmed: true` and
   `detected_at` set to now. If `.crewbench/project.md` doesn't exist yet,
   offer to create a short starter (languages/frameworks/source dirs already
   known, blank sections for folder structure, state management, styling and
   testing conventions) for the user to fill in — keep it under ~60 lines.

   Then compute agy allow-rule suggestions:
   `python3 <root>/bin/crewbench_profile.py agy-rules --commands '<json of
   the confirmed commands>'`, and show them with the exact snippet to paste
   into `~/.gemini/antigravity-cli/settings.json`'s `permissions.allow`
   list. Never edit that file yourself — only show what to paste.

3. **`edit <change>`**: apply the described change in plain language (e.g.
   "test command is npm run test:ci", "add a note that we use feature-based
   folders", "typecheck is null, we don't have one") to `project.json` or
   `project.md`. Show the result and ask to confirm before writing.

4. Never write `project.json` or `project.md` without the user confirming
   the values first — the detector's output in step 2 is always a proposal,
   never saved silently. This is also what happens automatically, once, the
   first time `/crewbench:new-task` runs in a project with no
   `project.json` (see dispatch.md §0) — this skill is the same flow,
   callable any time after that to refresh or correct it.
