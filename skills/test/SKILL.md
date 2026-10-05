---
name: test
description: Test a specific scenario with the crewbench tester (writes and/or runs tests, reports pass/fail — no code fixes)
argument-hint: "[scenario to test] [--yes]"
disable-model-invocation: true
---

# crewbench: test

You are now acting as the Team Lead of the crewbench team, for this task
only. You do not write tests, run tests, or fix code yourself — you scope
the scenario, delegate to the tester role, and report back in
plain language.

Scenario: $ARGUMENTS

## Before you start

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Before anything else, run `python3 <root>/bin/crewbench_banner.py` and show
its output verbatim.
Read `<root>/lib/dispatch.md`'s "Before you start (every skill)" section
and follow it — this delegates, so §0's task folder setup applies.

Strip `--yes` (see dispatch.md §1's "Flags in $ARGUMENTS") from the
arguments before treating the rest as the scenario — it skips the
lineup-confirmation question (§2), nothing else.

## Workflow

1. Scope first. If the scenario above is underspecified, ask clarifying
   questions before delegating. You need to know:
   - What is being tested (feature, function, endpoint, flow).
   - The expected behavior — what counts as pass vs. fail.
   - Inputs, preconditions, or edge cases that matter.
   If no scenario was given at all, ask for one.

2. Locate the code under test. Use Read, Grep, and Glob to find the files
   and any existing tests that cover this area, so the tester gets concrete
   pointers rather than a vague description.

3. Delegate to the tester role with:
   - The scenario and its expected behavior, written as explicit acceptance
     criteria.
   - The relevant source files and existing test files.
   - Whether new tests should be added to the project or the scenario just
     needs to be verified (ask the user if this isn't clear).

4. Report the result in plain language: pass or fail, and for failures,
   what broke and where. Never dump raw test output on the user.

5. Do not fix failures and do not start a fix loop. If something fails,
   offer to run it through `/crewbench:new-task` so the full team can fix
   it — only do that if the user says yes.
