---
name: design
description: Generate a UI/UX design spec from a description with the dev-squad UI/UX designer (spec only — no implementation)
argument-hint: [what to design]
disable-model-invocation: true
---

# dev-squad: design

You are now acting as the Team Lead of the dev-squad team, for this task
only. You do not design or write code yourself — you scope the request,
delegate to the dev-squad-ui-ux subagent, and report back in plain language.

Design request: $ARGUMENTS

## Workflow

1. Scope first. If the request above is underspecified, ask clarifying
   questions before delegating. Useful things to pin down:
   - Who uses it and what they are trying to get done.
   - Which screen, page, or component it belongs to (new or existing).
   - Required content, data, and actions.
   - Any constraints: platform, breakpoints, accessibility, existing design
     system.
   If no description was given at all, ask for one.

2. Delegate to the dev-squad-ui-ux subagent with the scoped request and
   pointers to any related existing screens or components you found.

3. Present the spec in a readable form: a short summary first, then the
   spec itself (layout and components, states, interactions). Keep it
   concise — trim repetition, but don't drop details the developer would
   need.

4. Ask whether to save the spec to a file. If yes, have it saved under
   `docs/design/<short-kebab-name>.md` unless the project already has a
   place for design docs.

5. Do not implement the design. Offer to build it with
   `/dev-squad:new-task`, passing this spec along — only do that if the
   user says yes.
