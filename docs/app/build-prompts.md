# CrewBench App — Build Prompts

These prompts take crewbench from a plugin to an installable local tool with a UI (daemon + web UI + CLI), while keeping the plugin working.

## How to use this file

1. Commit **Part A (Master Context)** into the repo as `docs/app/CONTEXT.md` before starting. Every phase prompt tells the agent to read it first, so you don't have to paste it each time.
2. Run one phase at a time, in order. Each phase has a numbered list of milestones. Run **one milestone per session** (paste the phase prompt, then say "do milestone N"). Phases are too big for one session, especially on a subscription plan.
3. Every phase starts with a plan file that the agent writes and you review. Don't skip that review. It is where you catch bad decisions cheaply.
4. Each phase ends with a "Definition of done". Don't start the next phase until all of it holds.

---

# Part A — Master Context (save as `docs/app/CONTEXT.md`)

```markdown
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
```

---

# Part B — Phase Prompts

## Phase 0 — Harden the contract (Python plugin side)

```markdown
Read docs/app/CONTEXT.md first, then bin/crewbench_state.py,
bin/crewbench_dispatch.py, schemas/task-state.json, lib/dispatch.md §0 and §4,
and skills/status/SKILL.md and skills/resume/SKILL.md.

## Goal
Make the `.crewbench/` on-disk format a safe, versioned contract that a
separate app (a long-running daemon running several tasks at once) can rely on,
without changing plugin behavior for users.

## Scope

1. **Race-free state writes.** In crewbench_state.py, `load_state` → mutate →
   `save_state` and the index.json read-modify-write currently happen outside
   the lock. Hold one lock across the whole read-modify-write, for both
   state.json and index.json, the way `update_status` in crewbench_dispatch.py
   already does. Move `_lock_file`/`_unlock_file` into a small shared module
   (e.g. bin/crewbench_fs.py) so crewbench_state.py stops importing from
   crewbench_dispatch.py. Add tests that run N concurrent `set`/`append`
   processes and assert no lost updates, for both state.json and index.json.

2. **UTC timestamps.** Every timestamp written anywhere in `.crewbench/` becomes
   UTC ISO-8601 with an explicit offset (e.g. `2026-09-18T14:03:22Z`).
   Human-facing log lines may keep a short local time prefix, but any
   structured field must be UTC. Readers must still accept old naive
   timestamps; treat them as local time.

3. **Collision-proof task ids.** Keep the readable form but add a short random
   suffix: `YYYYMMDD-HHMM-<slug>-<4 hex>`. Old ids must keep working everywhere
   (status, resume, cleanup).

4. **Schema version.** Add `schema_version` to state.json, index.json,
   status.json entries, and every result envelope. Start at 1. Missing means
   version 0 (legacy), and readers must handle it.

5. **events.jsonl.** Add an append-only `.crewbench/tasks/<id>/events.jsonl`.
   One JSON object per line, with this shape:
   `{ "v": 1, "ts": "<UTC>", "seq": <int, monotonic per task>, "type": "<type>",
      "task_id": "...", "run": "<run name or null>", "data": { ... } }`
   Write the event types we can produce today:
   - task.created, task.phase_changed, task.round_started, task.note_added
   - run.started, run.finished (ok/error, exit code, duration, usage summary)
   - run.message, run.tool_call, run.tool_error (from the live stream parser;
     same content as the .log lines but structured)
   - gate.finished (steps + pass/fail)
   - git.warning (from the before/after snapshot checks)
   Every appended event must use a lock plus `seq` so concurrent writers
   (tester + reviewer runs) never interleave partial lines or duplicate seq.
   crewbench_state.py `set`/`append` should emit `task.phase_changed` /
   `task.round_started` when those keys change, so plugin-driven tasks produce
   events without the LLM Team Lead having to remember to.
   Document every event type and its `data` fields in
   docs/app/contract/events.md.

6. **Codex structured events.** Check whether the installed `codex exec`
   supports a JSONL event output mode (`--json` or equivalent — verify with
   `codex exec --help`). If it does, add a codex parser to `Stream` that
   captures session id, messages, tool calls, errors, and real token usage,
   with a recorded fixture in tests/fixtures/. Do the same investigation for
   Copilot CLI. If no structured mode exists, keep the text fallback and record
   the finding (with CLI version) in docs/compatibility.md.

7. **Root-safe test.** Skip
   test_nonexistent_dir_under_a_read_only_ancestor_is_not_writable when
   running as root (`os.geteuid() == 0`), because root ignores chmod.

8. **Contract docs.** Write docs/app/contract/README.md describing the whole
   `.crewbench/` layout: every file, who writes it (plugin Team Lead, dispatch
   script, state helper, future app), who reads it, and its schema. This is the
   document Phase 1 will implement against.

## Out of scope
Any TypeScript. Any change to the workflow itself. UI.

## Milestones
1. Shared fs/lock module + race-free state/index writes + concurrency tests.
2. UTC timestamps + collision-proof ids + schema_version (with legacy reads).
3. events.jsonl writer + event emission from dispatch and state helper + docs.
4. Codex/Copilot structured-output investigation and parsers.
5. Contract README + CHANGELOG entry + version bump via scripts/bump_version.py.

## Definition of done
- Full pytest suite passes on the existing CI matrix (Linux, macOS, Windows;
  Python 3.9 and 3.12).
- A real `/crewbench:new-task` run in Claude Code produces a valid events.jsonl
  with no gaps in seq, and status/resume still work on a task created before
  this phase.
- docs/app/contract/README.md and events.md fully describe what's on disk.
```

---

## Phase 1 — Headless TypeScript engine + CLI (no UI)

```markdown
Read docs/app/CONTEXT.md, docs/app/contract/README.md,
docs/app/contract/events.md, lib/dispatch.md (all of it — it is the spec),
skills/new-task/SKILL.md, all of bin/, all of schemas/, config/defaults.json,
and tests/fixtures/.

## Goal
Run the full new-task workflow from TypeScript code, end to end, in a
terminal: `crewbench run "<task>"`. The workflow must be at parity with the
plugin, but the state machine is code and the LLM is used only where judgment
is needed. Tasks written by the app must be readable by the plugin
(`/crewbench:status` and `/crewbench:resume` work on them), and the reverse.

## Scope

### packages/contract
- zod schemas for: team.json, project.json, state.json, index.json,
  status.json, result envelope, each role's result (developer, tester,
  code-reviewer, ui-ux), events (discriminated union on `type`), and a NEW
  task-spec schema (below).
- A script that generates JSON Schema from zod into the repo's root schemas/
  directory. The Python code keeps reading those files. CI fails if the
  generated files are out of date.
- Keep the codex strict-schema transform (every property required, optional
  fields unioned with null) plus the null-normalization on read. Port the
  existing tests for it.

### New: task-spec (output of scoping)
{ title, description, acceptance_criteria[], affected_areas[],
  out_of_scope[], needs_design: boolean, design_notes?, jira_key?,
  constraints[] }
It is stored as `.crewbench/tasks/<id>/spec.json`, and state.json points to it.

### packages/adapters
One adapter per CLI (claude, codex, agy, copilot) behind one interface:
  buildCommand(role, model, effort, permissions, promptFile, schema, cwd, session?)
  parseLine(line) -> NormalizedEvent[]    // run.message / run.tool_call / ...
  finalResult(...) -> { result, permissionDenials, error }
  extractUsage(...) -> Usage
  resumeCommand(sessionId) -> string
  doctor() -> DoctorReport
Port behavior exactly from crewbench_dispatch.py, including: permission modes
and flags per CLI and role, tool scoping, agy denied-command resume (up to 2
times), argv size guard with prompt-file pointer, the recursion guard env var,
child env stripping, sandbox-error classification, and the doctor checks
(installed, config dir writable, network, auth). Use the existing
tests/fixtures streams as golden tests: the TS parsers must produce the same
facts the Python parsers do.

### packages/engine
- **Pure transition function**: `reduce(state, event) -> state`, and
  `decide(state) -> Command[]`, where Command is one of: dispatch run, run
  gate, request approval, create worktree, commit, finish, and so on. There is
  no I/O in these two functions, so they can be unit tested exhaustively.
  Phases: scoping, design, implementing, verifying, fixing, awaiting_commit,
  done, stopped, failed. (If you want an extra internal phase such as
  `gating`, propose it in the plan, and make sure it maps back to a
  plugin-readable phase.)
- **Loop rules** as pure, tested functions, straight from lib/dispatch.md §6:
  - the gate short-circuit (a failing gate step becomes the fix list, with no
    tester/reviewer that round);
  - the severity threshold (tester verdict not pass, OR a reviewer
    issue/previous_issue still_present at or above fix_threshold);
  - one combined fix list;
  - max_rounds (with the per-task override);
  - stuck detection (same file+category still_present two rounds running; same
    test+file failing twice);
  - below-threshold issues become optional follow-ups.
- **Issue registry**: the engine owns issue identity across rounds. It assigns
  ids and passes the registry to the reviewer. If the reviewer's
  previous_issues can't be matched by id, fall back to file + category +
  similar title, and record which matching method was used.
- **Runner**: executes Commands. It spawns adapters detached, writes
  status.json/events.jsonl/logs/result files in exactly the contract layout,
  and runs tester and reviewer in parallel. It supports cancel (process-group
  kill, Windows included) and a per-run timeout.
- **Git**: the worktree pre-flight (base_commit, dirty tree check, create the
  `.crewbench/wt/<id>` worktree on branch `crew/<id>` — or the Jira-key form —
  copy workspace.copy files, run workspace.setup), before/after snapshots with
  the same warning rules as the Python code (HEAD moved, branch switched,
  stash changed, previously-dirty files reverted/deleted, reviewer changed
  anything, tester touched non-test files), delta diffs per round, commit on
  the task branch, and cleanup.
- **Gate**: port crewbench_gate.py.
- **Profile**: port detection from crewbench_profile.py.
- **Handoffs**: generate each role's handoff from templates using spec +
  round data + the previous round's issues/failures + diffs. This is
  deterministic, with no LLM. The role briefs in agents/*.md are still
  prepended exactly as the Python code does.
- **LLM Team Lead calls** (run through the adapters, on the CLI the user picks
  for the lead role):
  1. Scoping: an interactive, multi-turn conversation that ends with a
     schema-valid task-spec. It uses the CLI's session resume so each turn
     continues the same conversation.
  2. Final summary: a plain-language report built from the final state. There
     must be a deterministic fallback summary if this call fails.
- **Approvals**: the engine emits `approval.requested { id, kind, payload }`
  and pauses until `approval.resolved { id, decision, data }`. The kinds are:
  confirm_profile, lineup, design (yes/no), dirty_tree, worktree_setup,
  commit, push, integrate (merge / cherry-pick / leave / nothing),
  cleanup_worktree. commit and push can never be auto-resolved by any setting.
- **Resume**: rebuild state by replaying events.jsonl (fall back to state.json
  for plugin-created tasks). Detect runs marked running whose pid is dead, and
  offer to re-dispatch them.
- **Concurrency limiter**: a per-CLI max number of concurrent runs, from config
  (default 2 per CLI). Runs queue when the limit is hit, and the engine emits
  run.queued.

### packages/cli
`crewbench` bin with:
- `run "<task>" [--spec spec.json] [--yes] [--design] [--in-place] [--rounds N]
  [--dev cli[:model]] [--review cli[:model]]` — the same flags as the plugin.
  Approvals are resolved through terminal prompts.
- `status [task-id]`, `resume <task-id>`, `cancel <task-id> [run]`
- `doctor [--cli X]`, `team [show|set ...]`, `profile [show|refresh]`

## Out of scope
Daemon, UI, packaging/publishing, custom roles.

## Milestones
1. Workspace scaffold, contract package, JSON Schema generation + CI check.
2. Adapters with golden tests from the existing fixtures, plus doctor.
3. Engine core: reduce/decide + loop rules + issue registry, all unit tested
   (target: every rule in dispatch.md §6 has a named test).
4. Runner + git + gate + profile, integration-tested with fake CLIs (port
   tests/fixtures/fake_clis to TS or reuse them as external scripts).
5. Scoping + summary LLM calls + approvals + terminal CLI.
6. Resume/cancel/concurrency + cross-compat tests: create a task with the app
   and read it with crewbench_state.py; create one with the Python helpers and
   resume it with the app.
7. A real end-to-end run on a throwaway repo with a mixed lineup (e.g. Claude
   lead, agy developer, codex reviewer). Record the result in
   docs/compatibility.md.

## Definition of done
- `crewbench run` completes a real task end to end, with the worktree, gate,
  parallel verification, at least one fix round, and a commit approval.
- `/crewbench:status <id>` in the plugin correctly shows an app-created task.
- Tests pass on Linux, macOS, and Windows in CI (add a Node job to ci.yml).
```

---

## Phase 2 — Daemon + read-only UI

```markdown
Read docs/app/CONTEXT.md, docs/app/contract/*, and the Phase 1 packages
(contract, engine, cli). Then read docs/app/phase-1-plan.md's notes for
anything that changed along the way.

## Goal
Run `crewbench ui` to start a local daemon and open a browser UI that shows
every crewbench task in registered projects — including tasks started from the
plugin inside Claude Code/Codex/Copilot/agy — with live agent progress. It is
read-only in this phase: no starting or approving tasks from the UI yet.

## Scope

### packages/daemon
- Binds to 127.0.0.1 only, on a configurable port (default: pick a fixed one,
  and fall back if it is busy).
- **Security**: generate a random token at startup. `crewbench ui` opens the
  browser with the token, and the UI keeps it in memory and sends it on every
  request. Reject requests without it. Check the Origin header. Never listen
  on 0.0.0.0.
- **Project registry**: `~/.crewbench/projects.json` (a list of absolute
  project paths plus display names). Include endpoints to add or remove a
  project. Adding validates that it is a git repo.
- **Watchers**: watch each project's `.crewbench/` (index.json, tasks/*/
  state.json, status.json, events.jsonl) with a robust file watcher, debounced.
  Tail events.jsonl incrementally by byte offset. Keep an in-memory index;
  files stay the source of truth.
- **API**, with every response validated against the contract zod schemas:
  GET /api/projects
  GET /api/projects/:pid/tasks
  GET /api/tasks/:tid                  (state + spec + rounds + usage)
  GET /api/tasks/:tid/runs/:run/log     (supports ?from=offset)
  GET /api/tasks/:tid/diff?round=N|base (unified diff vs base_commit or a round delta)
  GET /api/tasks/:tid/events           (SSE; supports Last-Event-ID = seq for replay)
  GET /api/events                      (SSE; global task-level events for the board)
  GET /api/doctor                      (runs adapters' doctor for all CLIs; cached)
- It handles legacy (schema_version 0) plugin tasks gracefully: they show
  what's available, and missing pieces are labeled rather than causing crashes.

### packages/ui (React)
Design direction: a calm, dense developer tool (think Linear or GitHub
Actions, not a marketing site). Support dark and light themes, full keyboard
navigation, and a responsive layout down to laptop widths.

Screens:
1. **Projects** — cards per project showing active and recent task counts, plus
   an "add project" button (path input + validation).
2. **Task board** — columns by phase (Scoping, Design, Implementing, Verifying,
   Fixing, Awaiting commit, Done/Stopped/Failed), updated live. Cards show the
   title, round `2/3`, role avatars with live status dots, a Jira key if
   present, and elapsed time.
3. **Task detail** — the core screen:
   - Header: title, phase, round, branch/worktree, base commit, lineup chips
     (role → cli · model · effort · permissions).
   - **Rounds timeline**: per round, the gate result (per step), then the
     tester and reviewer lanes side by side, then the verdict (fix list sent /
     approved / stuck).
   - **Agent lanes**: one per run, showing a live event stream (messages, tool
     calls, errors) with filters, an auto-scroll lock, a raw log toggle,
     duration, a usage line, and a copy button for the resume command.
   - **Issues table**: every issue across rounds with severity, file:line,
     category, status per round (open / resolved / still_present / stuck), and
     whether it was below threshold (optional follow-up).
   - **Test failures table**: same idea for tester failures.
   - **Diff tab**: file tree plus diff viewer, switchable between "vs base" and
     "round N delta".
   - **Spec tab**: acceptance criteria, scope, and out-of-scope items.
   - **Screenshots tab**: shown when visual verification produced any.
   - **Warnings banner**: git safety warnings, surfaced prominently.
4. **Health** — the doctor results per CLI (installed, auth, network, config
   dir), with the exact fix hint when something fails.
5. **Usage** — per task and per role: runs, duration, tokens/cost where
   known. Unknown values are shown as "—", never as 0.

### packages/cli
`crewbench ui [--port N] [--no-open]` starts the daemon and opens the browser.

## Out of scope
Starting, cancelling or approving from the UI; the scoping chat; packaging.

## Milestones
1. Daemon skeleton + auth token + project registry + task listing API.
2. Watchers + events tail + SSE with replay + tests (simulate a plugin writing
   files, and assert the SSE output).
3. UI shell, routing, theming, projects page, live task board.
4. Task detail: header, rounds timeline, agent lanes (live).
5. Issues/failures tables, diff viewer, spec/screenshots tabs, warnings.
6. Health + usage pages; polish; empty/loading/error states for every view.

## Definition of done
- Start a task with `/crewbench:new-task` in Claude Code. With `crewbench ui`
  open, it appears on the board within 2 seconds, and each role's progress
  streams live in its lane.
- Killing and restarting the daemon mid-task loses nothing (SSE replays from
  seq).
- There are UI component tests for the rounds timeline and issues table, plus
  one Playwright smoke test of the board → task detail flow against a fixture
  project.
```

---

## Phase 3 — Interactive UI (create, scope, approve, control)

```markdown
Read docs/app/CONTEXT.md, the contract docs, and the engine, daemon and ui
packages.

## Goal
Make the UI a full replacement for the plugin workflow: create a task, scope it
in a chat with the Team Lead, pick the lineup, then watch it run, answer
approvals, and cancel, resume or retry — all from the UI. The daemon hosts the
engine.

## Scope

### Daemon
- Host engine instances. Each task runs in the daemon process with the Phase 1
  runner. Crew runs stay separate detached processes, so a daemon restart
  doesn't kill them. On startup, reattach to live runs (pid check) and
  resume engine state from events.
- A global scheduler that enforces the per-CLI concurrency limits across all
  projects and tasks, and emits run.queued/run.dequeued.
- New endpoints:
  POST /api/projects/:pid/tasks         { text | jira_key, flags }  -> task id (phase: scoping)
  POST /api/tasks/:tid/scoping/messages  { text }  -> streams the lead's reply via SSE
  POST /api/tasks/:tid/scoping/finalize  -> lead returns task-spec; user can edit before confirming
  POST /api/tasks/:tid/approvals/:aid    { decision, data }
  POST /api/tasks/:tid/cancel            { run? }
  POST /api/tasks/:tid/resume
  POST /api/tasks/:tid/retry-run         { run }
  GET/PUT /api/projects/:pid/team        (team.json, validated)
  GET/PUT /api/projects/:pid/profile     (project.json/project.md, validated)
- Tasks started by the plugin stay observe-only in the UI (label them "running
  in <host CLI>"). The UI must never write to a task another process owns.
  Record ownership in state.json (`owner: "plugin" | "app"`) and respect it.

### UI
1. **New task** dialog: task text or a Jira key, the project, and flags as
   toggles (design, in-place, rounds, dev/review overrides).
2. **Scoping chat**: a chat with the Team Lead, streaming replies. A side panel
   shows the draft spec as it takes shape. "Finalize" produces the spec as an
   editable form (acceptance criteria as an editable list). Confirming moves
   the task to the lineup step.
3. **Lineup step**: a table of roles with CLI/model/effort/permissions
   dropdowns. Model options come from the tier table plus free text. Show
   warnings inline: a `skip` role runs arbitrary commands; mixing native and
   headless no longer applies, since everything is headless. Include the
   doctor status per chosen CLI, and a "save as project default" checkbox.
4. **Needs-you inbox**: a global badge plus a panel listing every pending
   approval across all tasks, each rendered as a card with the relevant
   context:
   - commit: the proposed message (editable), `git diff --stat`, full diff link;
   - push: the remote and branch;
   - integrate: merge / cherry-pick / leave / nothing, with what each will do;
   - dirty_tree / worktree_setup / design / confirm_profile: plain yes/no with
     details.
   Commit and push cards have no "always allow" option — enforce that in the
   engine, not only the UI.
5. **Run controls** in agent lanes: cancel run, retry run, and open the
   session (copy the resume command in this phase; the embedded terminal
   comes in Phase 4).
6. **Team settings page** per project: edit team.json (lineup, tiers, loop,
   workspace, confirm_lineup) with validation and a diff preview before saving.
7. **Profile page** per project: show, refresh (re-detect), and edit the
   profile, with confirmation before writing.
8. **Desktop notifications** (browser Notification API, opt-in) when a task
   needs approval, finishes, gets stuck, or fails.

## Milestones
1. Engine hosting in the daemon + reattach/resume on restart + ownership.
2. Scheduler + concurrency across tasks + queue visualization.
3. New-task dialog + scoping chat + spec editor.
4. Lineup step + team/profile settings pages.
5. Approvals: engine API + inbox + all card types + notifications.
6. Cancel/resume/retry controls + end-to-end Playwright test using fake CLIs
   (create → scope → lineup → run → fix round → commit approval → integrate).

## Definition of done
- A real task goes from "New task" to a merged commit entirely through the UI.
- Two tasks in two projects run at once, and the per-CLI limits are respected
  (visible queueing).
- Restarting the daemon mid-run resumes cleanly, with no lost approvals.
- The plugin still works, and plugin-owned tasks appear read-only in the UI.
```

---

## Phase 4 — Packaging, install, multi-project polish

```markdown
Read docs/app/CONTEXT.md and all packages.

## Goal
Anyone on macOS, Linux or Windows can install crewbench with one command and
have it running in under two minutes. The UI can also open real agent sessions
in an embedded terminal.

## Scope
1. **Publishing**: publish the `crewbench` npm package (the CLI) with the built
   UI bundled as static assets served by the daemon. Install with
   `npm i -g crewbench` or run with `npx crewbench ui`. Pick the package name
   after checking npm availability.
2. **First-run onboarding** in the UI:
   - detect which of the 4 CLIs are installed and logged in (doctor), with
     install/login instructions per CLI;
   - add the first project;
   - offer to install the plugin into each detected CLI (show the exact
     command and run it only on confirmation).
3. **Embedded terminal** (optional dependency node-pty): an "Open session"
   button in an agent lane opens an xterm.js tab running that run's
   resume_command in the task's worktree. If node-pty isn't available, fall
   back to copying the command.
4. **Background service** (optional): `crewbench service install|uninstall`
   to run the daemon at login (launchd / systemd user unit / Windows Task
   Scheduler), with clear uninstall.
5. **Settings**: global config at `~/.crewbench/config.json` — port,
   per-CLI concurrency limits, default lineup, notification preferences,
   theme. The UI settings page edits it.
6. **Plugin ↔ app bridge**: if the app is installed, the plugin's
   `/crewbench:status` mentions `crewbench ui`. Add a new
   `/crewbench:open [task-id]` skill that opens the task in the UI.
7. **Updates**: the daemon checks npm for a newer version at most once a day
   and shows a non-blocking banner. It never auto-updates.
8. **Release pipeline**: extend bump_version.py so the plugin manifests and
   app packages share one version. Add a GitHub Actions release workflow
   (build, test on all 3 OSes, publish on tag) and a CHANGELOG.
9. **Docs**: rewrite the README to cover plugin and app, a quick start with
   screenshots, and a troubleshooting section (built from real doctor failure
   modes).

## Milestones
1. Build/bundle + npm publish dry run + install tests in clean CI containers
   on 3 OSes.
2. Onboarding flow + plugin install helper.
3. Embedded terminal with fallback.
4. Global settings + background service.
5. Bridge skill + update banner + release workflow + docs.

## Definition of done
- On a clean machine with one CLI logged in: `npx crewbench ui` → onboarding →
  first task running in under 2 minutes.
- node-pty failing to build doesn't break install or the UI.
- A tagged release publishes automatically with tests green on all 3 OSes.
```

---

## Phase 5 — Custom agents and pipelines

```markdown
Read docs/app/CONTEXT.md, the contract docs, and the engine package
thoroughly, especially reduce/decide and the loop rules.

## Goal
Let users create their own agents (roles) and, in a limited way, their own
pipelines, without breaking the guarantees of the built-in workflow.

## Scope
1. **Custom roles**, stored in `.crewbench/roles/<name>/` (project) or
   `~/.crewbench/roles/<name>/` (global):
   - role.json: name, description, kind (`builder` edits code; `checker`
     reads only and returns a verdict plus issues; `designer` writes docs
     only), default cli/model/effort/permissions, and tool limits;
   - brief.md: the role prompt;
   - result schema: must extend the base schema for its kind, so the engine
     can still merge verdicts and issues generically.
   Examples to ship as templates: security-reviewer (checker),
   accessibility-reviewer (checker), docs-writer (builder, limited to docs/**),
   performance-reviewer (checker).
2. **Role builder UI**: a form for role.json, a brief editor with a preview of
   the final assembled prompt (brief + limits + schema), a "test run" button
   against a sample diff, and validation that blocks unsafe combinations
   (e.g. a checker with write tools).
3. **Pipelines**, deliberately constrained. Keep the fixed skeleton — scope →
   (design) → build → gate → verify → fix loop → commit — but let users
   configure:
   - which checker roles run in the verify stage (in parallel), each with its
     own fix_threshold;
   - optional extra builder steps after the main developer (e.g. docs-writer);
   - pipeline presets saved per project (e.g. "frontend feature",
     "hotfix: no design, 1 round", "security-sensitive: + security reviewer,
     threshold minor").
   No arbitrary graphs: document why in the plan.
4. **Engine changes**: generalize the loop rules from "tester + reviewer" to
   "N checkers", with the same combined-fix-list, threshold, and stuck
   semantics. Existing tasks and the plugin must behave identically when using
   the default pipeline, so the built-in roles become the default preset.
5. **Plugin compatibility**: the plugin keeps supporting only the built-in
   roles. The UI marks tasks using custom roles as "app-only".

## Milestones
1. Role package format + validation + templates.
2. Engine generalization to N checkers, with a regression suite proving the
   default pipeline is unchanged.
3. Pipeline presets + lineup UI support.
4. Role builder UI + test run.

## Definition of done
- A project with a custom security-reviewer checker runs a task where that
  checker's issue at or above its threshold triggers a fix round, and stuck
  detection works for it.
- The full Phase 1–3 regression suite passes unchanged on the default pipeline.
```

---

# Part C — Tips for running these

- **Plan mode first.** In Claude Code, start each phase in plan mode so the plan file gets written and reviewed before any code.
- **Dogfood from Phase 2 onward.** Once `crewbench run` works (end of Phase 1), build later milestones *with* crewbench itself: Claude as lead and reviewer, a cheaper model as developer. You'll find real UX problems early, and the UI in Phase 2 will immediately have real tasks to show.
- **Keep lib/dispatch.md as the spec until Phase 1 is done.** After that, the engine's tests become the spec. Update dispatch.md only for plugin-side behavior.
- **Watch the subscription limits.** Phases 1 and 3 are the heaviest. One milestone per session keeps each context focused and avoids hitting limits mid-milestone.
- **When a milestone goes sideways**, don't let the agent pile fixes on top. Revert to the last milestone commit, update the plan file with what you learned, and rerun.
