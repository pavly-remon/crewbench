# CrewBench App — Master Context

## What exists today
crewbench (this repo) is a plugin for Claude Code, Codex CLI, Copilot CLI and
Antigravity CLI (agy). A Team Lead (the host CLI's LLM) scopes a task and
delegates to four roles: developer, tester, code-reviewer, ui-ux (opt-in).
Any role can run on any of the four CLIs, with its own model/effort/permissions.

Key existing pieces (read these before changing anything):
- lib/dispatch.md — the full workflow protocol, written as instructions for an
  LLM Team Lead. This is the de-facto spec of the workflow.
- skills/*/SKILL.md — the slash commands (new-task, test, review, design,
  team, status, resume, doctor, profile).
- bin/crewbench_dispatch.py — runs one role headlessly on one CLI: builds the
  command, streams output into a readable log, parses the JSON result,
  validates it against schemas/, snapshots git before/after, extracts usage,
  supports detached start/wait/cancel, and runs `doctor`.
- bin/crewbench_state.py — task state.json + .crewbench/index.json helpers.
- bin/crewbench_gate.py — deterministic gate (format/lint/typecheck/tests).
- bin/crewbench_profile.py — project profile detection.
- schemas/*.json — result schemas per role, task-state, project.
- config/defaults.json — default lineup, model tiers, loop and workspace settings.
- tests/ — pytest suite, including stream fixtures and fake CLIs.

## What we are building
A standalone, installable local tool:
- A **contract**: the `.crewbench/` on-disk format, versioned and schema-defined,
  shared by the plugin and the app. Both read and write it. It is the single
  source of truth.
- An **engine** (TypeScript) that runs the workflow as a real state machine in
  code. It uses an LLM only for the steps that need judgment: scoping,
  optional handoff enrichment, and the final summary.
- **CLI adapters** (TypeScript), one per CLI (claude, codex, agy, copilot). Each
  one builds the command, parses output into normalized events, extracts usage,
  and runs doctor checks.
- A **daemon** — a local HTTP server that runs tasks, streams events to the UI,
  and handles approvals.
- A **web UI** (React), served by the daemon on localhost, to create tasks,
  watch each agent live, review diffs/issues, approve gates, and configure the
  team.
- A **CLI** (`crewbench`) — run tasks headlessly, start the UI, run doctor.

## Non-negotiable principles
1. Same concepts as the plugin: the roles, lineup (cli/model/effort/permissions
   per role), model tiers, worktree isolation, deterministic gate, parallel
   tester + reviewer, combined fix list, severity threshold, max rounds,
   stuck/oscillation detection, git safety snapshots, usage reporting, the
   project profile, Jira input, and visual verification.
2. The plugin keeps working at every phase. Never break `.crewbench/` compatibility
   without a schema version bump and a migration.
3. Commit and push are always explicit human approvals. No flag, setting or
   automation can skip them. Crew roles never commit or push.
4. Deterministic logic lives in code with unit tests, not in prompts. This
   covers transitions, thresholds, stuck detection, round caps and gate
   short-circuits.
5. Every agent run is observable: a status entry, a live event stream, a log
   file, a usage record, and a resume command. No invisible runs, so no native
   in-process subagents in the app. Everything runs headless.
6. The user runs on CLI subscriptions, not API keys. Never call model APIs
   directly. Always drive the installed, logged-in CLIs. Respect per-CLI
   concurrency limits.
7. Cross-platform: macOS, Linux, Windows. Preserve every Windows fix already in
   the Python code (UTF-8 everywhere, argv quoting, process-group kill, stdin
   handling).
8. Never guess CLI flags, event formats or model names. Verify against the
   installed CLI's `--help` or real output. Mark anything unverified with a
   `VERIFY:` comment, as the existing code does.

## Target repo layout (monorepo in this same repo)
Plugin files stay exactly where they are (marketplaces need them at the root).
The app lives in a pnpm workspace:

app/
  package.json            (workspace root, private)
  pnpm-workspace.yaml
  packages/
    contract/   zod schemas + generated JSON Schemas + event types + fixtures
    adapters/   per-CLI command builders, stream parsers, usage, doctor
    engine/     state machine, runner, git ops, gate, loop rules, approvals
    daemon/     HTTP + SSE API, task scheduler, project registry
    ui/         React app (Vite)
    cli/        `crewbench` bin (published package)

## Stack
- TypeScript strict, ESM, current Node active LTS (check which version that is;
  don't assume). pnpm workspaces.
- zod for all schemas. JSON Schema for the Python side is *generated* from zod
  into the repo's existing schemas/ directory, so there is one source of truth.
- vitest for tests. Port the existing pytest fixtures as golden tests.
- Daemon: Fastify (or Hono) with Server-Sent Events for live streams.
- UI: React + Vite + TanStack Query + TanStack Router + Tailwind + shadcn/ui.
  Use a diff viewer component, and xterm.js for terminal views.
- Process spawning: node child_process with process groups (detached on POSIX,
  CREATE_NEW_PROCESS_GROUP on Windows) and tree-kill semantics that match the
  Python implementation.
- node-pty only for the optional embedded terminal. It must be an optional
  dependency: the app must work if it fails to install.

## Working agreement for every phase
- Before coding, read this file, lib/dispatch.md, and the files the phase names.
- Write `docs/app/phase-<N>-plan.md`: milestones, file list, decisions, open
  questions, risks. Stop and wait for my review before implementing.
- Work milestone by milestone. Each milestone ends with passing tests, a short
  note appended to the plan file, and a commit (conventional commits:
  feat/fix/chore/docs/test).
- Don't add dependencies beyond the stack above without listing them in the
  plan with a reason.
- If the existing Python behavior and lib/dispatch.md disagree, stop and ask.
  Don't pick one silently.
