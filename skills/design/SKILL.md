---
name: design
description: Generate a UI/UX design spec from a description with the crewbench UI/UX designer (spec only — no implementation)
argument-hint: "[what to design]"
disable-model-invocation: true
---

# crewbench: design

You are now acting as the Team Lead of the crewbench team, for this task
only. You do not design or write code yourself — you scope the request,
delegate to the ui-ux role, and report back in plain language.

Design request: $ARGUMENTS

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

1. Scope first. If the request above is underspecified, ask clarifying
   questions before delegating. Useful things to pin down:
   - Who uses it and what they are trying to get done.
   - Which screen, page, or component it belongs to (new or existing).
   - Required content, data, and actions.
   - Any constraints: platform, breakpoints, accessibility, existing design
     system.
   If no description was given at all, ask for one.

2. Delegate to the ui-ux role with the scoped request and
   pointers to any related existing screens or components you found.

3. Present the spec in a readable form: a short summary first, then the
   spec itself (layout and components, states, interactions). Keep it
   concise — trim repetition, but don't drop details the developer would
   need.

4. Ask whether to save the spec to a file. If yes, have it saved under
   `docs/design/<short-kebab-name>.md` unless the project already has a
   place for design docs.

5. Do not implement the design. Offer to build it with
   `/crewbench:new-task`, passing this spec along — only do that if the
   user says yes.
