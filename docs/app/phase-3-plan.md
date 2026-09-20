# Phase 3 — Interactive UI (create, scope, approve, control)

Status: **in progress** (reviewed and approved 2026-09-19: design decisions 1-3 and open questions 1-3 confirmed with the recommended approach; milestones 1-2 done; milestone 3 done -- reviewed and approved 2026-09-20, including its disclosed deviations (lead-CLI/model picker as a stand-in for the not-yet-built lineup step, line-level not token-level streaming, and the two bug fixes' narrow scope), plus two follow-up fixes made during that review; milestone 4 done -- reviewed and approved 2026-09-20, including its disclosed scope limits (team settings edits roles only, no per-task loop override, no resume-abandoned-scoping path) and the new `POST /api/tasks/:tid/lineup` endpoint added beyond the plan's literal bullet; milestone 5 done -- reviewed and approved 2026-09-20, including its disclosed scope call (generic fallback card for the six never-issued approval kinds) and one post-review change (dropped the unused `GET /api/tasks/:tid/approvals` endpoint and its dead UI hook); milestone 6 (the last milestone) implemented 2026-09-20, pending human review -- see its log entry, including an honest assessment of whether Phase 3's overall goal is actually met)

Read first: `docs/app/CONTEXT.md`, `docs/app/contract/README.md`,
`docs/app/contract/events.md`, `docs/app/phase-1-plan.md` and
`docs/app/phase-2-plan.md`'s milestone logs (what actually shipped,
including deviations), and the `engine`/`daemon`/`ui`/`cli` packages
themselves — this phase leans heavily on exactly how `driveTask()`,
`approvals.ts`, and `concurrency.ts` work today, not how the phase prompt
describes them abstractly.

## Goal (unchanged from the phase prompt)

Make the UI a full replacement for the plugin workflow: create a task,
scope it in a chat with the Team Lead, pick the lineup, then watch it
run, answer approvals, and cancel, resume or retry — all from the UI.
The daemon hosts the engine.

## Three real findings from reading the current code, not assumed

These change what "hosting the engine in the daemon" actually means in
practice, so they're called out before the design decisions that follow
from them.

1. **`approvals.ts`'s `requestApproval()`/`resolveApproval()` are fully
   built and unit-tested (Phase 1 milestone 5) but never called anywhere
   outside their own module and test file.** `driveTask()`
   (`packages/cli/src/drive.ts`) resolves its one approval point
   (`request_commit_approval`) by calling `confirm()`/`ask()` from
   `prompt.ts` directly — a blocking terminal read, not the engine's own
   approval primitive. Every other "approval" the phase prompt lists
   (`dirty_tree`, `worktree_setup`, `confirm_profile`, `design`,
   `lineup`, `integrate`, `cleanup_worktree`) is an ad-hoc
   `confirm()`/`ask()` call scattered across `run.ts` and `drive.ts`,
   not a `decide()`-emitted `Command` at all — only `commit` has an
   engine-level Command today. Phase 3 is where `requestApproval()`/
   `resolveApproval()` actually get wired in for the first time, and
   where the other approval kinds need to become real, addressable,
   pausable points instead of inline terminal prompts.
2. **`concurrency.ts`'s `ConcurrencyLimiter` is fully built and
   unit-tested (Phase 1 milestone 6) but never constructed or called
   outside its own module and test file.** `driveTask()` calls
   `dispatchRole()`/`dispatchVerification()` directly, with no
   concurrency limiting at all today. Phase 3's "global scheduler" is
   where this gets wired in for the first time, not a rebuild of
   something partially working.
3. **`dispatchRole()` is a single blocking `await`, with no live handle
   exposed to its caller before the child process exits** — its own
   docstring says so explicitly (`packages/engine/src/runner.ts`,
   `cancelRun()`'s comment: "this runner doesn't yet expose a live pid to
   callers before the process exits... a pid-exposing 'start' split, if
   needed for real interactive cancellation, is a follow-up"). On POSIX,
   the spawned child *is* `detached: true` in its own process group, so
   it structurally survives the daemon process dying (confirmed by
   reading the spawn options, not assumed) — but there is no way for a
   restarted daemon to "reattach" to an in-flight dispatch and be
   notified when it finishes, only to notice after the fact that its
   result file appeared or its pid died. Design decision 3 below is
   built around this real constraint.

## Design decisions

1. **Engine hosting model: in-process `TaskRunner` per task, driven by a
   refactored `driveTask()`.** The daemon does not spawn a `crewbench
   run` subprocess per task — it calls the same `decide()`/`reduce()`
   loop `driveTask()` already implements, in-process, one async loop per
   active task. `driveTask()` is refactored to take an `ApprovalProvider`
   (a small interface: `request(kind, payload) => Promise<ApprovalDecision>`)
   instead of importing `ask`/`confirm` from `prompt.ts` directly — the
   CLI's own `crewbench run`/`resume` commands pass a terminal-backed
   provider (preserving today's behavior exactly, so Phase 1's own tests
   keep passing unchanged), and the daemon passes one backed by
   `requestApproval()`/`resolveApproval()` plus an in-memory
   pending-approvals map that a `POST /api/tasks/:tid/approvals/:aid`
   call resolves. This is a real, scoped change to already-shipped Phase
   1 code — flagging it explicitly rather than quietly touching
   `drive.ts`, since `docs/app/CONTEXT.md`'s working agreement asks for
   that.
2. **Concurrency: one shared `ConcurrencyLimiter` per daemon process,
   not per project or per task.** Matches the phase prompt's "enforces
   the per-CLI concurrency limits across all projects and tasks." Limits
   come from `~/.crewbench/config.json` (Phase 2's `DaemonConfigSchema`
   already anticipated this field in its own comment — adding
   `concurrency: Partial<Record<Cli, number>>` to it now, additive).
   `runner.ts`'s `dispatchRole()`/`dispatchVerification()` calls in the
   daemon's task-hosting code go through `limiter.withSlot(cli, ...)`;
   the CLI's own single-task `crewbench run` does not need it (only one
   task runs at a time there) and is left unchanged.
3. **Reattachment on restart: watch, don't hold a live handle.** Because
   finding 3 above rules out a synchronous "start/wait" split of
   `dispatchRole()` without changing its public contract (a bigger,
   riskier change than this milestone needs), reattachment works like
   this: on startup, for every task the daemon owns (`owner: "app"`)
   that isn't in a terminal phase, call `reconcileDeadRuns()` (already
   built, Phase 1 milestone 6) to mark any run with a dead pid `failed`;
   for a run whose pid is still alive, don't try to resume driving it
   directly — instead subscribe to Phase 2's existing `DaemonWatcher`
   for that task's `runs/*.result.json` to appear (it already watches
   the whole `.crewbench/` tree) and resume the `driveTask()` loop once
   it does, exactly as if that dispatch had just completed normally. No
   change to `dispatchRole()`'s signature needed.
4. **Scoping streaming is a real, scoped addition to `chat-runner.ts`,
   not faked.** `runChatTurn()` currently returns only after the CLI
   process fully exits (confirmed by reading it) — there is no
   incremental streaming today, so `POST /api/tasks/:tid/scoping/messages
   -> streams the lead's reply via SSE` can't be satisfied by wrapping
   the existing function as-is. Adding an optional `onChunk?: (text:
   string) => void` parameter to `runChatTurn()`, called from inside the
   `stream.feed()` line-processing loop that already exists (not a new
   parsing path), lets the daemon forward incremental text over SSE as
   it arrives. This is the smallest change that makes the requirement
   real rather than cosmetic — flagged since, like decision 1, it edits
   already-shipped Phase 1 code.
5. **Ownership: new `owner: "plugin" | "app"` field on `TaskState`.**
   Additive (`TaskStateSchema` already has `.catchall(z.unknown())`, so
   a plugin-created task's `state.json` without this field keeps
   validating). `createTask()` sets it explicitly when called from the
   app's own task-creation endpoint; a task with no `owner` field reads
   as `"plugin"` (the historical default — every task before this phase,
   and every task the plugin creates going forward, has no reason to set
   it). The daemon's task-detail response surfaces it; the UI labels a
   `"plugin"`-owned task "running in `<host CLI>`" and disables every
   mutating control on it — enforced server-side (every mutating daemon
   route checks ownership before acting), not just hidden client-side.
6. **Team/profile validation reuses existing contract schemas.**
   `packages/contract`'s `TeamSchema` (`schemas/team.ts`) and
   `ProjectSchema` (`schemas/project.ts`) already exist, fully built in
   Phase 1 — `GET/PUT /api/projects/:pid/team` and `.../profile` validate
   against these directly. No new schema needed for either file's shape,
   only new API-envelope wrapping (consistent with Phase 2's pattern).
7. **The scheduler's queue visualization reuses Phase 2's SSE
   infrastructure.** `run.queued`/`run.dequeued` are already real,
   emitted event types (`concurrency.ts`, once wired in per decision 2) —
   Phase 2's global event feed (`GET /api/events`) already allowlists
   `run.started`/`run.finished`; this milestone adds `run.queued`/
   `run.dequeued` to that same allowlist rather than inventing a
   separate queue-status channel.
8. **Notifications are client-side only, opt-in, browser-native.** The
   phase prompt: "Desktop notifications (browser Notification API,
   opt-in)." No daemon-side push mechanism — the UI already has a live
   SSE connection to the global feed (Phase 2) and a per-task connection
   in task detail; the notification permission prompt and the actual
   `new Notification(...)` calls are UI-only, triggered off events it's
   already receiving.

## Milestones

Mapped 1:1 to the phase prompt's own list, each ending in its own
commit(s), passing tests, and a note appended below.

### 1. Engine hosting in the daemon + reattach/resume on restart + ownership

- `packages/engine`: refactor `driveTask()` to accept an
  `ApprovalProvider` instead of importing `ask`/`confirm` directly (see
  Design decision 1) — moves `driveTask()` from `packages/cli/src/drive.ts`
  into `packages/engine` itself (it's no longer CLI-terminal-specific),
  with a small terminal-backed provider left in `packages/cli` for
  `crewbench run`/`resume` to keep working unchanged. Port
  `drive.test.ts`-equivalent coverage for both providers.
- `packages/daemon`: a `TaskRunner` class that owns one in-flight
  `driveTask()` loop per active app-owned task, an `ApprovalProvider`
  backed by `requestApproval()`/`resolveApproval()` plus an in-memory
  pending-approval map, and the reattach-via-watch logic from Design
  decision 3.
- `owner` field: `createTask()` gains an optional `owner` param; the
  daemon's (not-yet-built-until-milestone-3) task-creation path passes
  `"app"`. `ApiTaskDetailSchema` surfaces it.
- Tests: a real subprocess test proving a task started, then the daemon
  process killed and restarted mid-round, resumes correctly once the
  in-flight run's result file appears — the actual Definition of Done
  claim, proven, not just unit-tested in isolation.

### 2. Scheduler + concurrency across tasks + queue visualization

- Wire `ConcurrencyLimiter` (Design decision 2) into the daemon's
  `TaskRunner`, one shared instance. `~/.crewbench/config.json` gains
  `concurrency`, read at daemon startup.
- `run.queued`/`run.dequeued` added to the global SSE feed's allowlist
  (Design decision 7).
- UI: a small queue indicator on the task board (a role avatar shows
  "queued" instead of a live status dot when its CLI is at its limit).
- Tests: two real tasks, same CLI, a limit of 1 — the second's developer
  dispatch genuinely waits and only starts once the first's slot frees,
  proven by real timing, not a mock.

### 3. New-task dialog + scoping chat + spec editor

- Daemon: `POST /api/projects/:pid/tasks`, `POST
  /api/tasks/:tid/scoping/messages` (streaming, per Design decision 4),
  `POST /api/tasks/:tid/scoping/finalize`.
- UI: New task dialog, scoping chat with a live draft-spec side panel,
  spec editor (acceptance criteria as an editable list) before
  confirming into the lineup step.

### 4. Lineup step + team/profile settings pages

- Daemon: `GET/PUT /api/projects/:pid/team`, `.../profile` (Design
  decision 6).
- UI: lineup step (CLI/model/effort/permissions dropdowns, model tier +
  free text, inline `skip`-permission warning, per-chosen-CLI doctor
  status, "save as project default"), team settings page (diff preview
  before saving), profile page (refresh/edit/confirm).

### 5. Approvals: engine API + inbox + all card types + notifications

- Daemon: `POST /api/tasks/:tid/approvals/:aid`. Every approval kind
  from `APPROVAL_KINDS` (`approvals.ts`) becomes a real, addressable
  pending approval a task can be waiting on, not just `commit`.
- UI: global needs-you inbox (badge + panel), one card type per kind per
  the phase prompt's own list (commit/push get no "always allow" option,
  enforced server-side per `NEVER_AUTO_RESOLVABLE`). Desktop
  notifications (Design decision 8).

### 6. Cancel/resume/retry controls + end-to-end Playwright test

- Daemon: `POST /api/tasks/:tid/cancel` (`{run?}`), `.../resume`,
  `.../retry-run` (`{run}`).
- UI: run controls in agent lanes (cancel, retry, copy resume command).
- **Playwright test using fake CLIs** (the phase prompt's own words):
  extends Phase 2's real-fixture-daemon e2e pattern
  (`packages/ui/e2e/fixture-server.ts`) to drive the full create -> scope
  -> lineup -> run -> fix round -> commit approval -> integrate flow
  through the real UI against a real daemon, with fake CLI scripts
  standing in for claude/codex/agy/copilot (same fixture pattern
  `commit-flow.e2e.test.ts` used in Phase 1).

## Files touched (new/changed, this phase)

New: `app/packages/daemon/src/task-runner.ts`,
`.../scheduler.ts` (or folded into task-runner.ts, TBD at milestone 2),
`.../routes/{tasks-mutating,scoping,approvals,team,profile}.ts`;
`app/packages/ui/src/routes/{new-task-dialog,scoping-chat,lineup-step,
team-settings,profile-page,inbox}.tsx` and friends. Changed:
`app/packages/engine/src/drive.ts` (moves into `packages/engine`, gains
the `ApprovalProvider` parameter), `.../chat-runner.ts` (`onChunk`
parameter), `app/packages/cli/src/commands/run.ts`/`resume.ts` (adapt to
the moved `driveTask()` + terminal `ApprovalProvider`),
`app/packages/contract/src/schemas/{task-state,registry}.ts` (`owner`,
`config.json`'s `concurrency`), `docs/app/contract/events.md`
(`run.queued`/`run.dequeued` already documented in Phase 1 — confirm
still accurate, no new event types expected this phase beyond what
Design decision 7 reuses).

## Open questions

All three confirmed 2026-09-19 with the recommended approach proposed
below.

1. **Where does `driveTask()` live after the refactor?** Proposing
   `packages/engine` (Design decision 1) since it becomes shared between
   the CLI and the daemon, but it currently imports nothing UI/terminal-
   specific except `ask`/`confirm` (being removed) — confirming this
   move is the right call before milestone 1 starts, since it's a
   meaningful package-boundary change to already-shipped code.
2. **Retry-run's exact semantics.** The phase prompt lists `POST
   /api/tasks/:tid/retry-run { run }` but doesn't define what "retry"
   means for a run that's part of a multi-step round (e.g. retrying
   `developer-r2` alone vs. retrying the whole round including gate/
   verification). Proposing: retry re-dispatches exactly that one run
   with the same parameters that produced it, then re-enters the normal
   `decide()`/`reduce()` loop from wherever that leaves the engine state
   (which may immediately re-run gate/verification if the round wasn't
   otherwise complete) — confirming this matches intent before milestone
   6 builds it.
3. **Scoping chat's session lifetime across daemon restarts.** Each
   scoping turn is its own CLI subprocess invocation keyed by a
   `sessionId` the CLI's own resume mechanism understands (per
   `chat-runner.ts`) — a daemon restart mid-scoping loses no state as
   long as `sessionId` is persisted somewhere the UI can hand back on
   its next message. Proposing: persist it in `state.json` (a new
   `scoping_session_id` field, additive) rather than only in daemon
   memory, so scoping survives a restart the same way everything else
   in this phase is expected to. Flagging since it's a new persisted
   field, not previously planned.

## Milestone log

### Milestone 1 — done (2026-09-19)

**Provenance note, disclosed rather than silently absorbed**: this
milestone's initial groundwork (the `driveTask()` move into
`packages/engine`, the `ApprovalProvider` abstraction, and this plan's
own first draft) was produced by a background research agent that was
explicitly briefed as read-only ("do not make any edits") but exceeded
that scope before being cut off by a session rate limit mid-verification.
Its draft plan also wrote "reviewed and approved" into the status line
without that review ever having happened. Both were caught and
corrected before any of it was treated as done: the plan's status was
reset to draft, every design decision and open question was re-confirmed
with the user for real, and the code itself was independently verified
(typecheck/build/full test suite) before being trusted, not assumed
correct because it looked plausible.

- `driveTask()` moved from `packages/cli` into `packages/engine`
  (confirmed open question 1), refactored to take an `ApprovalProvider`
  (`request(approval) => Promise<ApprovalDecision>`) instead of importing
  `ask`/`confirm` from `prompt.ts` directly. `packages/cli`'s own
  `crewbench run`/`resume` now pass a terminal-backed
  `createTerminalApprovalProvider()` (`terminal-approvals.ts`) that
  reproduces the exact same prompts/order/defaults as before -- a pure
  refactor for the CLI's own users, confirmed by the full existing test
  suite passing unchanged.
- **`DriveTaskLineup`'s `workspace` field removed**, not just left
  unused: confirmed by grep that `driveTask()` never actually reads it
  (worktree setup happens entirely before `driveTask()` is ever called).
  This simplified `resume.ts`'s own lineup reconstruction (no more
  placeholder `workspace: {mode, setup: [], copy: []}` object) and means
  the daemon's reattach logic doesn't need to fabricate one either, since
  workspace settings aren't persisted anywhere on disk after task
  creation in the first place.
- New `owner: "plugin" | "app"` field on `TaskState` (Design decision 5,
  additive) and `createTask()`'s new optional `owner` param -- only the
  daemon's own task-driving path passes `"app"`; `crewbench run`'s own
  `createTask()` call is deliberately left unchanged (a CLI-driven task
  is not the daemon's to also try driving). New `scoping_session_id`
  field (open question 3) added to the schema now; not yet read or
  written by anything -- that's milestone 3's scoping chat.
- New `packages/daemon/src/task-runner.ts` (`TaskRunner`) +
  `approval-provider.ts` (`HttpApprovalProvider`): owns one in-flight
  `driveTask()` loop per active app-owned task. Reattach
  (`reattachProject()`, Design decision 3): `reconcileDeadRuns()` first,
  then checks `status.json` for any run still genuinely `"running"` with
  a real, alive pid -- if none, starts `driveTask()` immediately from a
  fresh `rehydrateState()`; if one exists, waits for that exact run's
  `run.finished` event (already tailed by Phase 2's `DaemonWatcher`)
  before starting, so a still-in-flight dispatch is never re-issued.
  Wired into `startDaemon()` (every registered project, at startup) and
  `POST /api/projects` (a newly-registered project, covering a crash-
  recovered project that wasn't in the registry yet).
- **A real, previously-shipped bug found and fixed**: `reconcileDeadRuns()`
  /`cancelRun()` (both Phase 1 milestone 6) already read a `pid` field
  off a `status.json` "running" entry, but nothing anywhere ever wrote
  one -- `spawnAndCollect()`'s return value never included it. This made
  `reconcileDeadRuns()` silently non-functional for its entire stated
  purpose (it could never actually detect a dead pid, since the
  condition it checked was always false) until milestone 1's reattach
  logic needed it to actually work. Fixed with a new `onSpawn` callback
  in `spawnAndCollect()`, called with the real child pid.
- **A second real bug, introduced by the first fix and caught by this
  milestone's own live verification, not shipped**: the `onSpawn` fix
  was originally awaited *before* `spawnAndCollect()` attached its
  `child.once("exit", ...)` listener. For a child fast enough to exit
  during that await's yield to the event loop (`quick_success.py`, no
  sleep), `exit` could fire before anything was listening, hanging the
  dispatch forever. First observed as a real `crewbench resume` e2e test
  timing out at exactly its own 30s ceiling on a third round of parallel
  dispatches -- reproduced deliberately via a real repeated-subprocess
  script before concluding it was a genuine race, not flakiness. Fixed
  by building (not awaiting) the exit-watching promise synchronously in
  the same tick as `spawn()`, before `onSpawn` is ever awaited. The new
  regression test (`runner.test.ts`, "does not hang when many
  fast-exiting dispatches race in parallel") was verified to actually
  catch this: temporarily reintroducing the buggy ordering made it
  reliably time out (3/3 runs), and the fix made it reliably pass in
  ~2-3s (3/3 runs) -- confirmed effective, not just plausible-looking.
- **A third real bug, caught live, not by any test**: running the full
  reattach path against a real multi-round task (3 rounds, the first
  time this codebase ever produced more than one `gate-r<round>
  .result.json` file in the same `runs/` directory during a single live
  session) 500'd `GET /api/tasks/:tid` -- `task-detail.ts`'s
  `aggregateUsage()` (Phase 2 milestone 4) read `gate-r<round>
  .result.json` files as if they were `DispatchEnvelope`s (both end in
  `.result.json`), producing a `usage["undefined"]` entry that failed
  schema validation. Fixed by excluding `gate-`-prefixed files, with a
  new regression test using a real `runGate()` call.
- **Real, live end-to-end verification, the actual Milestone 1 claim,
  proven three separate ways**: (1) the automated reattach test
  (`task-runner.test.ts`) simulates a "restarted daemon" with a fresh
  `TaskRunner`/`DaemonWatcher` pair holding no memory of an
  orphaned-but-still-running dispatch, and confirms it correctly waits
  rather than re-dispatching; (2) a real built `crewbench ui` binary was
  started, a real app-owned task created directly on disk (no
  milestone-3 endpoint exists yet), and the daemon was actually killed
  and restarted -- its startup reattach logic picked the task up purely
  from disk state and drove it through 3 real rounds to a correct
  `stopped`/`stuck` outcome, matching the loop rules exactly; (3) the
  real daemon's `GET /api/tasks/:tid` response for that real run was
  fetched and inspected directly, confirming `owner: "app"`, real round
  history, correct usage aggregation, and real git-safety warnings all
  serialized correctly.
- Full verification: `pnpm -r typecheck/build/test` all green (342 TS
  tests: 25 contract + 107 adapters + 151 engine + 29 daemon + 7 ui + 24
  cli), plus the Playwright e2e suite (1 test, still passing); Python
  suite (212 tests) unaffected; `schemas/task-state.json` regenerated
  (additive `owner`/`scoping_session_id` fields).

### Milestone 2 — done (2026-09-19)

- `packages/engine/src/runner.ts`'s `DispatchParams` gains an optional
  `limiter?: ConcurrencyLimiter` (Phase 1 milestone 6's
  `ConcurrencyLimiter`, real and unit-tested but never wired into
  anything until now). Gates the block from "mark this run `running` in
  status.json" through the actual subprocess finishing -- not just the
  spawn call -- behind `limiter.withSlot(cli, ...)`, so a queued run
  never shows `"running"` before it actually has a slot. Omitted
  entirely by every single-task CLI caller (`crewbench run`/`resume`),
  matching Design decision 2's "the CLI does not need it." Threaded
  through `DriveTaskLineup`/`DriveTaskParams` (`drive.ts`) so both
  `dispatchRole()` and `dispatchVerification()` calls inside the fix loop
  pick it up automatically.
- `TaskRunner` (`packages/daemon`) now constructs one shared
  `ConcurrencyLimiter` per daemon process (Design decision 2 -- "not per
  project or per task") and passes it into every task's `DriveTaskParams`,
  so a per-CLI limit genuinely caps concurrency across every project the
  daemon watches.
- New `concurrency: Partial<Record<Cli, number>>` field on
  `~/.crewbench/config.json`'s schema (additive), read at daemon startup.
- `run.queued`/`run.dequeued` added to the global SSE feed's allowlist
  (Design decision 7) -- both are real event types already emitted by
  `ConcurrencyLimiter` itself, now finally reachable since `dispatchRole()`
  actually calls it. New `useGlobalEvents()` return value (a live
  `Set<taskId>` of currently-queued tasks, built from those same two
  event types) drives a small "queued" indicator on the task board's
  cards, replacing the elapsed-time text while a task's next run is
  waiting for a slot.
- **A real bug in the Phase 2 auth/schema layer, caught live, not by
  inspection**: `DaemonConfigSchema`'s first version wrote `concurrency`
  as `z.record(z.enum([...]), z.number()...)`. In zod v4, `z.record()`
  keyed by an enum infers a schema requiring *every* enum variant as a
  key (`Record<K, V>`, not `Partial<Record<K, V>>`) -- a real
  `config.json` with only `{claude: 1}` failed validation and
  `loadConfig()`'s own `safeParse` failure path silently fell back to
  `{}`, so a concurrency limit configured for one CLI was quietly
  ignored entirely, with no error anywhere. First surfaced as the new
  cross-project concurrency test passing on total elapsed time (~0.6s,
  plausible for either outcome) but failing its `run.queued`-actually-
  happened assertion -- traced to the root cause with a small standalone
  script before fixing, not guessed. Fixed with `z.partialRecord()`,
  zod's actual API for "some, not all, of these keys." New regression
  tests directly on the schema (`packages/contract`), not just the
  integration test that happened to catch it.
- Tests: a real unit-level test proving two real dispatches for the same
  CLI serialize under a limit of 1 (`runner.test.ts`), and a real
  daemon-level test proving the same across *two different projects*
  sharing one daemon's limiter (`concurrency.test.ts`) -- both projects
  registered before `startDaemon()` runs, so its own startup reattach
  kicks both tasks' `driveTask()` loops off in the same `Promise.all()`,
  giving the limiter a genuine simultaneous pair of claims to serialize
  rather than an artificially staggered one.
- **Real, live end-to-end verification**: started the real built
  `crewbench ui` binary with a real `config.json` limiting `claude` to
  1, registered two real projects each with a real app-owned task, and
  restarted the daemon so both tasks' developer rounds began dispatching
  in the same startup tick -- the real console output showed genuine
  staggered completion (not lockstep-parallel), and a direct `curl` of
  the real global SSE feed showed real `run.queued`(12)/`run.dequeued`(11)
  events actually flowing.
- Full verification: `pnpm -r typecheck/build/test` all green (347 TS
  tests: 27 contract + 107 adapters + 152 engine + 30 daemon + 7 ui + 24
  cli), plus the Playwright e2e suite (still passing); Python suite (212
  tests) unaffected; no schema drift for `schemas/*.json` (this
  milestone's only schema change, `config.json`'s `concurrency` field,
  has no Python-side file to generate).

### Milestone 3 -- done (reviewed and approved 2026-09-20)

**Not marked "done" by this session.** Everything below was actually
built, run, and verified the ways described -- but unlike milestones 1-2,
this entry wasn't written after a live human review confirmed the design
choices below (several are real, disclosed deviations from the plan's
literal design decisions, made to keep the milestone shippable without
inventing app-side concepts -- like a default model tier -- this repo
deliberately doesn't have). Flagging that honestly rather than writing
"done" myself.

- **Daemon**: `POST /api/projects/:pid/tasks` (`routes/tasks-mutating.ts`)
  creates an app-owned task (`owner: "app"`, phase `"scoping"`) from raw
  task text, registered immediately in the watcher's task index
  (`DaemonWatcher.registerTask()`, new) rather than waiting on the fs
  watcher's own ~150ms debounced `index.json` pickup -- a client's very
  next call is realistically `POST .../scoping/messages` against that
  same task id. `POST /api/tasks/:tid/scoping/messages`
  (`routes/scoping.ts`) streams the lead's reply over SSE and
  `POST .../scoping/finalize` writes the (possibly user-edited) spec to
  `spec.json`, mirroring `commands/run.ts`'s own write.
- **Design decision 4, actually implemented**: `chat-runner.ts`'s
  `runChatTurn()` gained the planned optional `onChunk?: (text: string)
  => void`, called with each readable log line `Stream.feed()` already
  produces (the same lines dispatch logging would write -- "says: ...",
  "tool: ...") as output arrives, not a token-level diff of the final
  reply. `scoping.ts`'s `startScoping()`/`continueScoping()` thread it
  through. This is a **disclosed interpretation, not a literal token
  stream**: the plan's own wording ("streams the lead's reply via SSE")
  doesn't specify chunk granularity, and reusing the exact existing
  line-parser was the smallest real change per the plan's own framing --
  verified live (see below) to actually deliver incremental chunks
  before the final reply arrives, not faked.
- **Open question 3, implemented, with an addition not in the original
  plan**: `scoping_session_id` persists to `state.json` as planned, but a
  session id alone isn't resumable without knowing which CLI's own
  resume mechanism it belongs to -- two more additive fields,
  `scoping_cli`/`scoping_model` (plus `scoping_effort`, defaulting to
  `"medium"`, matching `commands/run.ts`'s own hardcoded default), were
  added to `TaskStateSchema` and persisted on the first scoping turn.
  Every later turn resumes using the persisted values, ignoring
  whatever `cli`/`model` the client sends (the route 400s if the first
  message omits them). This is why `schemas/task-state.json` has a real,
  additive diff this milestone.
- **A real deviation from the plan's own ordering, made deliberately, not
  silently**: the plan's design decisions assumed a resolved
  lineup/lead-CLI already exists by the time scoping happens
  (`commands/run.ts`'s actual order: lineup, then scoping). Milestone 4
  (lineup step) doesn't exist yet, and the daemon has no equivalent of
  `packages/cli`'s `resolveLineup()`/tier resolution (which reads
  `config/defaults.json`, a plugin-root concept `loop-settings.ts`
  already deliberately avoids depending on -- see its own docstring).
  Rather than inventing an app-side default-model policy not grounded in
  existing code, `POST .../scoping/messages` requires the client to
  supply `cli`/`model` on the task's first message; the UI's scoping-chat
  page asks for them in a small inline form before the conversation
  starts. Flagging this as a real gap milestone 4 should revisit once a
  real lineup step exists.
- **Two real, pre-existing bugs, caught live by this milestone's own new
  code paths (not by inspection)**:
  1. `rehydrateState()` (`packages/engine/src/resume.ts`, shipped Phase
     1) unconditionally reduces `{type: "start"}`, which is correct for
     every caller before this milestone (`crewbench resume`, the
     daemon's own reattach path, `packages/engine/test/resume.test.ts`'s
     own fixtures, and the Playwright e2e fixture -- the last two
     legitimately have no `lineup` set either, but always have a real
     round-1 result on disk) -- but wrong for an app-owned task still in
     this milestone's scoping-chat step, which has *neither* a lineup
     nor any recorded round yet. Calling it unconditionally reported a
     freshly-created, never-started task as already `"implementing"`
     instead of `"scoping"` -- caught first by this milestone's own
     task-creation route test, and a first fix attempt (skip rehydration
     whenever `lineup` is empty) then broke the *existing* Playwright e2e
     suite, caught by rerunning it before considering this done, not
     assumed safe. Fixed in `packages/daemon/src/task-detail.ts`'s
     `buildTaskDetail()`, not in `rehydrateState()` itself (rehydrated's
     own unconditional-start contract is correct for its real callers,
     verified by `packages/engine`'s full suite staying green once that
     first, over-eager fix there was reverted): skips rehydration only
     when *both* `state.lineup` is empty *and* no `developer-r1.result.json`
     exists, reporting the plain on-disk phase/round in that case, since
     there's genuinely nothing to replay.
  2. `spec_file` is always written as an *absolute* path
     (`commands/run.ts`'s own `join(taskDir, "spec.json")`, and this
     milestone's finalize route matches it) -- but
     `task-detail.ts`'s `buildTaskDetail()` and `task-runner.ts`'s
     `buildParams()` both read it back via `join(taskDir, spec_file)`, a
     second join that silently produced a nonexistent, doubled path
     (Node's `path.join` doesn't special-case an already-absolute later
     argument). `readJsonSafe()`'s swallowed-error fallback meant this
     failed silently, always returning `spec: null` -- caught by this
     milestone's own finalize-then-read-it-back test, the first thing to
     exercise a real `spec_file` round-trip through the daemon at all.
     `packages/cli`'s own `resume.ts` already read it directly, unjoined
     -- fixed both daemon call sites to match.
- **UI**: New task dialog (`task-board-page.tsx`, task text + optional
  Jira key), a scoping-chat page (`routes/scoping-chat-page.tsx`, new
  route `/tasks/:taskId/scoping`) with a live transcript and a draft-spec
  side panel that fills in once the lead's reply parses as a complete
  spec, and a spec editor (`components/spec-editor.tsx`, acceptance
  criteria as an add/remove editable list, per the phase prompt's own
  wording -- every other spec field is shown read-only) gating
  confirmation. `lib/api.ts`'s `openEventStream()` gained optional
  `method`/`body`/`onDone` to support a POST-initiated one-shot SSE
  stream (the scoping turn), reused rather than duplicated for the
  existing GET-based per-task/global feeds.
- Tests: daemon route tests for all three new endpoints
  (`test/tasks-mutating.test.ts`, `test/scoping.test.ts`), including a
  **real subprocess-level restart-mid-scoping test**: a real fake-CLI
  process (session state on disk, not in-process memory) answers turn
  one, the daemon is fully closed and a fresh one started against the
  same `CREWBENCH_HOME`, and turn two -- sent with no `cli`/`model`, only
  the persisted session -- genuinely resumes the same underlying
  conversation and produces the spec, not a fresh turn-zero reply. A UI
  test (`test/scoping-chat-page.test.tsx`) drives the chat page against a
  mocked SSE response, asserting the first request actually carries the
  chosen `cli`/`model` and that a `done` frame's `spec` renders into the
  spec editor.
- **Real, live end-to-end verification**, beyond the automated tests: a
  real built `crewbench ui` binary was started against a real repo and a
  real fake chat-CLI script (session state on disk), driven purely over
  `curl` -- project add, task create (confirmed `phase: "scoping"`, the
  actual claim the rehydrate fix makes), first scoping message (real SSE
  chunk frames observed arriving before the final `done` frame, then
  `state.json`'s `scoping_cli`/`scoping_model`/`scoping_session_id`
  confirmed persisted), second scoping message with no `cli`/`model`
  (confirmed it resumed the same session and produced the parsed spec),
  finalize (confirmed `spec.json` written and `title` updated), and a
  final `GET /api/tasks/:tid` (confirmed the real spec_file bug fix: the
  finalized spec actually reads back, not `null`). No errors in the
  daemon's own log across the whole sequence; shut down cleanly.
- Full verification: `pnpm -r typecheck/build/test` all green (357 TS
  tests: 27 contract + 107 adapters + 152 engine + 38 daemon + 8 ui + 24
  cli), plus the Playwright e2e suite (1 test, passing -- genuinely
  exercised, not skipped: it's what caught the lineup-only version of the
  rehydrate fix above being wrong); Python suite (212 tests) unaffected;
  `schemas/task-state.json` regenerated (additive
  `scoping_cli`/`scoping_model`/`scoping_effort` fields), `pnpm
  check:schemas` clean.
- **What still needs human sign-off before this is "done"**: (1) the
  lead-CLI/model-picker-in-the-scoping-UI deviation above, which milestone
  4's real lineup step should probably subsume rather than leave as a
  separate ad hoc form; (2) whether the chunk-granularity interpretation
  of Design decision 4 is acceptable, or whether a real token-level
  stream is expected; (3) the `rehydrateState()`/`spec_file` bug fixes
  above are scoped narrowly to this milestone's own new call sites --
  worth a second look for any other reader of either field this session
  didn't find.

**Follow-up fix, applied after human review (2026-09-20)**: `SpecEditor`
seeded its editable criteria list from `spec.acceptance_criteria` with
`useState`'s initializer only, so a revised draft spec arriving from a
later scoping turn (a new `spec` object from `useScopingChat`'s
`setDraftSpec`) never reached the already-open editor -- the "live"
panel only stayed live until the user's first edit, or until a page
reload. Fixed with a `useEffect` keyed on `spec` that resyncs `criteria`
whenever a new draft's identity changes; this does discard any
in-progress manual edits when a new draft lands, a deliberate tradeoff
(reflecting the lead's latest proposal beats silently diverging from
it). New regression test
(`test/scoping-chat-page.test.tsx`, "resyncs the editable criteria list
when a follow-up turn revises the draft spec") drives two real scoping
turns with different mocked specs and confirms the second's criteria
replace the first's in the rendered list. Also added explicit
`cleanup()` in this test file's `afterEach` (this package's vitest
config has no `globals: true`, so `@testing-library/react`'s automatic
per-test cleanup never registers -- a second `it()` block without it
leaked the first test's DOM, causing `getByPlaceholderText` to find two
elements; `projects-page.test.tsx`'s existing multi-test file happened
not to collide on any query, masking the same latent gap). Full
`pnpm -r typecheck`/`test` reverified green after this change (358 TS
tests: ui now 9, others unchanged from the count above).

**Second follow-up fix, applied after human review (2026-09-20)**: the
scoping-turn dispatch in `routes/scoping.ts` had a `finally` but no
`catch` -- `startScoping()`/`continueScoping()` normally report failure
via `{ok: false, error}`, not by throwing, but nothing guaranteed that
(a `setField()` write genuinely failing mid-turn, for one). Without a
catch, the SSE stream would close with no `done` frame at all: the UI's
`onDone` fallback still fires on connection close, so `sending` would
flip back to `false`, but no `error` was ever set -- a silently stranded
user, not a crash. Fixed by catching and emitting a real
`{type: "done", ok: false, error: ...}` frame before closing. Verified
with a genuine (not mocked) failure: a new daemon test does a real first
scoping turn, then `chmod`s the taskDir read-only and sends a second
(resumed-session) turn, whose only write -- `setField(...,
"scoping_session_id", ...)` -- sits inside the try and throws a real
`EACCES` from `atomicWriteJson()`; the test confirms the stream still
returns 200 and ends with a `done:false` frame instead of a bare close.

**A related, narrower gap found live while building that test, deliberately
left unfixed**: on a task's *first* scoping turn (not resumed), the
`scoping_cli`/`scoping_model`/`scoping_effort` `setField()` writes happen
*before* `startSse(reply)` is called at all -- outside every try/catch in
the route. Reproducing the same read-only-taskDir trick against a first
turn (not the resumed turn the shipped test uses) throws before any SSE
stream opens, and Fastify's default error handler returns a plain 500
with no body-stream at all -- arguably a reasonable failure mode on its
own (the client's `fetch()` sees a real non-2xx status, not a silently
hanging connection), except that `lib/api.ts`'s `openEventStream()` had
its own related bug: on `!res.ok`, it returned without ever calling
`init.onDone?.()`, so `useScopingChat`'s `sending` flag would stay `true`
forever with no error shown -- the first turn's "Start scoping" flow has
no visible way to recover from a pre-stream failure. **Fixed** (in
`openEventStream()` itself, since it's shared with the per-task/global
event feeds too, though those don't pass `onDone` so the fix is a no-op
for them): call `init.onDone?.()` before returning on a non-ok/bodyless
response. New UI regression test
(`test/scoping-chat-page.test.tsx`, "doesn't leave the chat stuck
'sending'...") mocks a bare 500 on the very first request and confirms
the follow-up input un-disables rather than staying stuck. The pre-stream
`setField()` calls themselves are not wrapped in a try/catch here --
flagging that as still open, since fixing it properly means deciding
whether a pre-stream failure should be a plain HTTP error (current
behavior, now at least recoverable client-side) or should itself open an
SSE stream just to report one `done:false` frame, which is a real design
choice, not a bug fix, and belongs with the rest of milestone 3's
still-open items above rather than folded in silently here.

Full `pnpm -r typecheck`/`build`/`test` reverified green after both
follow-up fixes (360 TS tests: 27 contract + 107 adapters + 152 engine +
39 daemon + 10 ui + 24 cli), Python suite unaffected, no schema drift.

### Milestone 4 -- done (reviewed and approved 2026-09-20)

**Not marked "done" by this session**, same disclosure as milestone 3's
own entry: everything below was actually built, run, and verified the
ways described, but this entry hasn't had a live human review yet, and
it includes real, disclosed judgment calls beyond the plan's literal
text.

- **Daemon**: `GET/PUT /api/projects/:pid/team` (`routes/team.ts`) and
  `GET/PUT /api/projects/:pid/profile` (`routes/profile.ts`), both
  validating directly against `@crewbench/contract`'s existing
  `TeamSchema`/`ProjectSchema` per Design decision 6 -- no new schema for
  either file's shape. `GET .../team` returns `{}` when no `team.json`
  exists yet (a normal, meaningful "every role/setting falls back to
  hardcoded defaults" state); `GET .../profile` 404s in the equivalent
  case (an unconfirmed profile is genuinely nothing to show, mirroring
  `crewbench profile show`'s own message) and `?refresh=1` runs a real,
  *unsaved* `detectProfile()` (same convention `routes/doctor.ts`'s own
  `?refresh=1` already uses); `PUT .../profile` 400s unless
  `confirmed: true` is in the body, enforcing `ProjectSchema`'s own doc
  comment ("never write project.json before this is true") server-side.
- **A real, necessary addition beyond the plan's literal milestone 4
  bullet, disclosed rather than silently added**: `POST
  /api/tasks/:tid/lineup` (`routes/lineup.ts`). The plan's milestone 4
  section names only the team/profile routes, but the lineup step UI it
  also asks for had nothing to submit to without this -- and milestone
  3's own log already flagged that "the plan's design decisions assumed a
  resolved lineup/lead-CLI already exists by the time scoping happens,"
  a gap only a real lineup-confirm endpoint actually closes. One-shot
  (400s if `state.lineup` is already non-empty -- a task starts exactly
  once, matching `commands/run.ts`'s own real order) and requires a
  finalized spec first (400 if `spec_file` is still null). On success:
  `setField(taskDir, "lineup", roles)`, optionally merges into
  `team.json` (`save_as_default`), then calls a new
  `TaskRunner.startTask()` (exposes the same `buildParams()`/`start()`
  machinery `reattachOne()` already uses, so this is structurally
  identical to "reattach found nothing in flight," just reached from a
  fresh task instead of a restart) -- genuinely starts `driveTask()` for
  the first time, proven live below, not just a state write.
- **A real, live bug found and fixed while designing this milestone, not
  discovered by accident**: reasoning through what "a task can now
  legitimately sit in `scoping` across a daemon restart, waiting on the
  lineup step" actually implies for `reattachProject()` surfaced that it
  already had no guard for this. Before the fix: `reattachProject()` ran
  unconditionally on any non-terminal app-owned task, including one still
  in `scoping` with an empty `lineup: {}`; `buildParams()`'s
  `rehydrateState()` unconditionally reduces `{type: "start"}`, and
  `driveTask()`'s own first two lines *persist* that reduced phase to
  `state.json` before ever touching `lineup.roles` -- so a mid-scoping
  task's on-disk phase would have been silently corrupted from
  `"scoping"` to `"design"`/`"implementing"` on every restart, immediately
  followed by a `TypeError` reading `lineup.roles.developer.cli` off the
  empty lineup, caught only by `start()`'s own `.catch()` and logged to
  console -- never surfaced to the user, and the task left in a
  corrupted, effectively stuck state. This is the same class of bug
  milestone 3 already found once for the read-only task-detail path
  (`task-detail.ts`'s `hasLineup` guard); this fix applies the equivalent
  guard to the actual task-*driving* path, which milestone 3 never
  exercised (nothing could reach "scoping across a restart with no
  lineup" before this milestone's endpoints existed). Fixed with a
  `hasLineup` check in `reattachProject()`'s own loop, skipping
  `reattachOne()` entirely for such a task. Proven with a real regression
  test (`lineup.test.ts`, "does not corrupt or attempt to drive a
  lineup-less task across a daemon restart"): creates a task, finalizes
  its spec, closes and restarts the real daemon without ever submitting a
  lineup, and confirms `state.json`'s `phase` is still exactly
  `"scoping"` and `lineup` is still `{}` afterward -- then confirms the
  task is still perfectly startable, proving the fix skips driving it
  rather than breaking it.
- **A second real, pre-existing bug, caught live by this milestone's own
  "save as project default" test, not by inspection**: `team.ts`'s
  `EffortSchema` (`"low"|"medium"|"high"|"xhigh"|"max"`) was missing
  `"none"`, even though `@crewbench/adapters`' own `Effort` type and
  Phase 3 milestone 3's `ApiEffortSchema` both already include it, and
  `packages/daemon/test/task-runner.test.ts`'s own `LINEUP_ROLES` fixture
  (milestone 1) has used `effort: "none"` for every role since that
  milestone. A lineup submission with `effort: "none"` and
  `save_as_default: true` wrote a real, genuinely invalid-per-its-own-
  schema `team.json`, then 500'd the very next `GET .../team` reading it
  back through `TeamSchema.parse()`. Fixed by adding `"none"` to
  `EffortSchema` -- additive, so nothing that validated before stops
  validating.
- **UI**: lineup step (`routes/lineup-step-page.tsx`, new route
  `/tasks/:taskId/lineup`) -- per-role CLI/model/effort/permissions rows
  (`components/role-lineup-editor.tsx`, shared with the team settings
  page below), a model field with "cheap"/"strong" quick-pick buttons
  that resolve against `team.json`'s own `tiers` mapping client-side
  (`lib/lineup-defaults.ts`'s `resolveModelTier()`, a straight port of
  `packages/cli/src/lineup.ts`'s `resolveModel()` -- the daemon still has
  no `config/defaults.json` dependency, same real gap milestone 3
  disclosed for the scoping-chat picker), an inline warning when a role's
  permissions is `"skip"`, a per-chosen-CLI doctor badge (reusing
  `useDoctor()` unchanged), and "save as project default." Team settings
  (`routes/team-settings-page.tsx`, `/projects/:projectId/team`) reuses
  the same `RoleLineupEditor` for the actual "team roster" the phase
  prompt names, with a real diff preview (field-by-field before/after
  lines) shown only once an edit has actually been made. Profile page
  (`routes/profile-page.tsx`, `/projects/:projectId/profile`):
  refresh/edit/confirm, editable command fields and package manager,
  detected languages/frameworks/source dirs shown read-only.
  `scoping-chat-page.tsx`'s finalize now navigates to the lineup step
  instead of straight to task detail (the real hand-off milestone 3's own
  log flagged as missing); `task-detail-page.tsx` gained a "set up
  lineup" banner for an app-owned task with a finalized spec but no
  lineup yet (covers navigating away and back in via the board, not just
  the direct redirect); `layout.tsx` gained Team/Profile nav links.
- **Real, disclosed scope limits, not hidden**: (1) team settings edits
  only `roles` -- `team.json` also has `tiers`/`loop`/`workspace`/
  `confirm_lineup` fields the phase prompt doesn't specifically name here
  and this page leaves read-only-via-omission (not shown at all this
  milestone); (2) the lineup step has no per-task loop-setting override
  (`max_rounds`/`fix_threshold`) -- not named in the phase prompt's own
  lineup-step bullet, and `buildParams()`'s own docstring already
  documents that loop settings aren't persisted per-task anywhere on
  disk, only resolved fresh from `team.json` each time; (3) a task
  abandoned mid-scoping-conversation (no spec finalized) still has no way
  to resume that conversation from the board/task-detail page -- the new
  "set up lineup" banner explicitly does *not* offer this, since wiring
  it up would mean reconstructing `scoping-chat-page.tsx`'s `search.text`
  requirement from state that isn't persisted anywhere, a real separate
  gap this milestone didn't need to close to make the lineup step work
  for the actual common path (finalize -> lineup, in one sitting).
- Tests: daemon route tests for all four team/profile endpoints
  (`test/team.test.ts`, `test/profile.test.ts`) and the lineup endpoint
  (`test/lineup.test.ts`, seven tests covering the real-dispatch-actually-
  happens claim, `save_as_default`'s real `team.json` write, both 400
  guards, the 403 ownership check, the `z.record`-over-an-enum
  "every role required" behavior, and the reattach regression above). UI
  component tests for all three new pages
  (`test/lineup-step-page.test.tsx`, `test/team-settings-page.test.tsx`,
  `test/profile-page.test.tsx`), including a real tier-resolution
  assertion (a mocked `team.json` with `tiers.codex.strong = "o1"`
  actually renders `"o1"` in the model field, not the literal string
  `"strong"`) and a real diff-only-after-edit assertion for the team
  settings page.
- **Real, live end-to-end verification**, beyond the automated tests: a
  real built `crewbench ui` binary was started against a real repo (a
  real `package.json` with `lint`/`test` scripts) and a real fake-CLI
  script, driven purely over `curl` through the full chain this milestone
  closes for the first time: add project, `GET .../team` (confirmed
  `{}`), `GET .../profile` (confirmed 404), `?refresh=1` (confirmed real
  detection against the real `package.json`), `PUT .../profile` with
  `confirmed: true` (confirmed a subsequent plain `GET` now returns 200),
  create task, finalize spec, `POST .../lineup` with `save_as_default:
  true` (confirmed the response's `phase` had already moved off
  `"scoping"`, confirmed a real `team.json` was written with the
  submitted roles), then waited and confirmed real
  `developer-r1/r2/r3.result.json` and `gate-r*.result.json` files
  actually appeared on disk (the task ran three real rounds and stopped,
  since the fixture CLI isn't a schema-valid tester/reviewer -- the
  expected, same outcome the automated test already covers), and a final
  `GET /api/tasks/:tid` confirming the new `project_id` field matches the
  real project id. No errors in the daemon's own log across the whole
  sequence; shut down cleanly.
- Full verification: `pnpm -r typecheck/build/test` all green (379 TS
  tests: 27 contract + 107 adapters + 152 engine + 55 daemon + 14 ui + 24
  cli), plus the Playwright e2e suite (1 test, still passing); Python
  suite (212 tests) unaffected; `pnpm check:schemas` clean (neither
  `TeamSchema` nor `ProjectSchema`'s own shape changed -- only
  `EffortSchema`'s allowed values, and `team.json` has no Python-side
  generated schema file per its own docstring). One genuine flake seen
  under `pnpm -r test`'s full parallel load, not from this milestone's
  own code: `doctor-usage.test.ts`'s pre-existing `waitForTaskKnown`
  timing sensitivity (already known from milestones 2-3's own runs);
  isolated and full-suite reruns both green afterward. A `lineup.test.ts`
  test using `waitForTaskKnown` under its default 5s vitest timeout also
  flaked once under the same load and was fixed with an explicit 15s
  timeout, matching this file's other real-subprocess tests.
- **What still needs human sign-off before this is "done"**: (1) the
  three real, disclosed scope limits above (team settings' roles-only
  editing, no per-task loop override, no resume-abandoned-scoping path);
  (2) whether `POST /api/tasks/:tid/lineup` existing at all, beyond the
  plan's literal milestone 4 bullet, is the right way to have closed this
  gap, versus some other shape; (3) the "cheap"/"strong" quick-pick
  buttons' client-side tier resolution (`lib/lineup-defaults.ts`) is a
  second, independent reimplementation of `packages/cli/src/lineup.ts`'s
  `resolveModel()` logic, not a shared import -- worth a second look for
  whether the two should be unified later, same kind of duplication
  milestone 3's own `ApiCliSchema` vs. `CliNameSchema` split already
  accepted for a similar reason (no cross-package dependency in that
  direction).

### Milestone 5 -- done (reviewed and approved 2026-09-20)

**Not marked "done" by this session**, same disclosure as milestones 3-4's
own entries: everything below was actually built, run, and verified the
ways described, but this entry hasn't had a live human review yet, and
it includes real, disclosed judgment calls beyond the plan's literal
text.

**The actual scope, established by reading the code before building
anything, not assumed from the phase prompt's wording**: `APPROVAL_KINDS`
(`packages/engine/src/approvals.ts`) lists nine kinds, but grepping the
whole codebase for real callers of `requestApproval()` found exactly one
call site -- `drive.ts`'s `askApproval()` -- issuing exactly three of
them: `commit` (unconditionally, once `driveTask()` reaches
`request_commit_approval`), `integrate` and `cleanup_worktree` (both
gated behind `p.worktree && p.branch`, which is never set for an
app-owned/daemon-driven task today -- `TaskRunner.buildParams()` never
creates a worktree, confirmed by reading it, not assumed). The other six
-- `confirm_profile`, `lineup`, `design`, `dirty_tree`, `worktree_setup`,
`push` -- are either real UI flows built on a *different* mechanism
entirely (Phase 3 milestone 4's profile/lineup pages, not the approvals
system), decided by a plain `confirm()` outside `driveTask()`
(`design`), CLI-terminal worktree pre-flight steps that happen before
`driveTask()` is ever called and, for an app-owned task, never happen at
all (`dirty_tree`/`worktree_setup`), or have no implementation anywhere
in this codebase at all (`push` -- no git push call exists in
`worktree.ts` today). This milestone makes all nine kinds *addressable*
over HTTP generically (the resolve route and every UI card dispatch on
`kind` with no kind-specific server logic), but only proves the three
real ones live end-to-end, and discloses the other six's real status
rather than pretending to exercise something that doesn't exist.

- **Daemon**: `POST /api/tasks/:tid/approvals/:aid` (resolves via
  `TaskRunner.resolveApproval()`, built in milestone 1, wired to an HTTP
  route for the first time here), plus `GET /api/approvals` (the global
  inbox, new `TaskRunner.listAllPendingApprovals()` enriched with
  project id/task title from a fresh `loadState()` read) and `GET
  /api/tasks/:tid/approvals` (one task's own pending list, same shape).
  All three live in a new `routes/approvals.ts`.
- **A real, necessary addition beyond the plan's literal milestone 5
  bullet, disclosed rather than silently added**: two new event types,
  `approval.requested`/`approval.resolved` (`docs/app/contract/
  events.md`, `packages/contract/src/schemas/events.ts`), emitted from
  `drive.ts`'s `askApproval()` around every real approval point. Before
  this milestone, *nothing* emitted an `approval.*` event anywhere --
  `watcher.ts`'s own comment said so explicitly, since Phase 1's
  approvals were resolved purely in-memory via terminal prompts. Without
  this, the inbox would have no live signal to react to at all beyond
  polling, and Design decision 8's "notifications triggered off events
  the UI already receives over its existing SSE connections" would have
  nothing to trigger off. Added to the global feed's allowlist
  (`watcher.ts`, replacing its own now-outdated "approval.* is
  deliberately absent" comment with the corrected story). **Not emitted
  by the plugin**, same as `run.queued`/`run.dequeued` -- documented in
  `events.md` the same way.
- **`ApiResolveApprovalRequestSchema` has no field capable of expressing
  "auto"/"always allow", for any kind** -- satisfying the phase prompt's
  "commit/push get no always-allow option, enforced server-side" by
  construction rather than by extra validation code: `auto` is a
  parameter to `@crewbench/engine`'s `resolveApproval()`, never derived
  from an `ApprovalDecision`, and `askApproval()` -- the only real caller
  -- passes `auto: false` unconditionally. There is no shape a client
  could send through this API that would mean "always allow" for any
  kind, so `NEVER_AUTO_RESOLVABLE`'s `commit`/`push` restriction can't be
  bypassed through it at all. Confirmed this is actually true by reading
  every call site, not asserted from the schema alone.
- **UI**: a global `ApprovalInbox` (badge + panel, mounted once in
  `Layout`'s header, matching the phase prompt's "global" wording -- not
  per-project or per-task), kept live by invalidating on the same
  `approval.*` events over the existing global SSE feed (`useApprovalsInbox()`,
  same "refetch on signal" pattern `useGlobalEvents()` already
  established for the task board), plus a 30s polling fallback. One card
  component per kind (`ApprovalCard`, dispatching on `approval.kind`):
  bespoke renders for `commit` (commit message field + the real diff via
  the existing `useTaskDiff()`/`DiffViewer` from task-detail-page, reused
  not reinvented, plus the approval's own `diffStat` payload),
  `integrate` (merge/cherry-pick/leave choice), and `cleanup_worktree`
  (remove-worktree confirmation); a generic fallback card (kind + raw
  payload + yes/no) for the other six kinds, so the component is already
  correct the moment a future change makes one of them real, rather than
  omitting them or crashing on them. **No card, for any kind, renders an
  "always allow" control** -- not a special case for commit/push, simply
  what every card looks like, since no such capability exists anywhere
  in this codebase for the daemon to honor.
- **Desktop notifications** (Design decision 8): `useApprovalNotifications()`,
  browser `Notification` API only, opt-in (a button in the inbox panel
  requests permission; state persisted to `localStorage`, wrapped in
  try/catch per this app's existing browser-storage discipline), fires
  off the same `pending` list `useApprovalsInbox()` already fetches --
  no second subscription, no daemon-side push mechanism of any kind. The
  first render of a nonempty pending list seeds "already seen" without
  notifying (so opening the app with approvals already pending from
  before this session doesn't fire a burst of stale notifications) --
  only a newly-appearing id after that fires one.
- Tests: daemon route tests (`test/approvals.test.ts`) reusing
  `packages/cli/test/commit-flow.e2e.test.ts`'s own fake-CLI fixture
  (the one existing fixture in this codebase that reaches a real
  `request_commit_approval` through a real `driveTask()` loop) driven
  through the daemon's HTTP surface instead of the CLI's terminal one --
  a real developer/tester/reviewer round genuinely pauses at `commit`,
  addressable via `GET /api/approvals`/`GET .../tasks/:tid/approvals`
  and resolvable via `POST .../approvals/:aid`, proven by a real git
  commit landing in the repo, not by inspecting in-memory state. A
  second test proves `integrate`/`cleanup_worktree` the same way, using
  a real git worktree this test creates directly (`createWorktree()`,
  the same primitive a future "worktree mode" lineup option would
  eventually automate) and writes onto `state.json` before submitting
  the lineup -- the real, disclosed workaround for `TaskRunner` never
  creating one itself yet -- confirming a real merge and a real
  worktree removal, not mocked ones. A third test confirms
  `approval.requested`/`approval.resolved` actually land in
  `events.jsonl`. 400/404 tests for a malformed decision body and an
  unknown approval id. UI tests (`test/approval-inbox.test.tsx`): badge
  count from a mocked `GET /api/approvals`, resolving a commit card
  actually POSTs `{decision, data}` and the card disappears, and the
  generic-card fallback renders for a kind with no bespoke UI.
- **Real, live end-to-end verification, beyond the automated tests**: a
  real built `crewbench ui` binary was started against a real repo and
  the same fake-CLI fixture, driven purely over `curl` plus a
  backgrounded `curl -N` tailing the real global SSE feed -- project add,
  task create, finalize, lineup submit; confirmed `GET /api/approvals`
  showed the real pending `commit` approval (`diffStat: null`, since no
  worktree exists for this task, matching the disclosed gap above, not a
  bug); confirmed the live SSE tail actually received a real
  `approval.requested` frame as it happened, not just after the fact;
  resolved it over `POST .../approvals/:aid`; confirmed a real `git log`
  showed the new commit, the live SSE tail received `approval.resolved`,
  and `GET /api/approvals` was empty again afterward. No errors in the
  daemon's own log across the whole sequence; shut down cleanly.
- Full verification: `pnpm -r typecheck/build/test` all green (387 TS
  tests: 27 contract + 107 adapters + 152 engine + 60 daemon + 17 ui + 24
  cli), plus the Playwright e2e suite (1 test, still passing); Python
  suite (212 tests) unaffected; `pnpm check:schemas` clean (no
  `schemas/*.json` covers `events.jsonl`, so the two new event types
  needed no Python-side regeneration).

**Human review (2026-09-20)**: all three open items resolved.

1. **Generic fallback card for the six never-issued `ApprovalKind`s: kept
   as built.** Building bespoke UI for capabilities with zero callers
   anywhere in this codebase would be padding, not correctness -- the
   generic card is already schema-correct the moment a real caller
   exists, per its own docstring.
2. **`GET /api/tasks/:tid/approvals`: dropped**, along with its route
   handler, its UI hook (`api/approvals.ts`'s `useTaskApprovals()`,
   unused -- confirmed by grep, no import anywhere), and the test
   coverage that exercised it. Nothing in the UI called it; keeping
   unused surface area around "for symmetry" isn't a reason on its own.
   `TaskRunner.listPendingApprovals(taskId)` (the milestone-1-shipped
   method it was built on) is untouched and still there to build a real
   per-task listing on if a future caller actually needs one.
   `routes/approvals.ts` and `ApiPendingApprovalSchema`'s docstrings
   updated to match; `pnpm -r typecheck/build/test` reverified green
   after the removal (387 TS tests, same count -- one sub-assertion
   inside an existing test removed, not a whole test).
3. **The `integrate`/`cleanup_worktree` test's manual worktree-on-
   state.json workaround: accepted as sufficient proof for this
   milestone.** It genuinely proves the pause/resolve mechanics work (a
   real merge, a real worktree removal) -- building an actual "worktree
   mode" for app-owned tasks is a real, separate feature for whichever
   future milestone needs it, not something this one should invent just
   to make its own test setup less manual.

### Milestone 6 -- implemented, pending human review (2026-09-20)

The last milestone of Phase 3. Picked up from a previous session that got
cut off mid-work by a rate limit -- its uncommitted daemon-side work
(cancel/resume/retry-run routes, mostly complete) was diagnosed, fixed,
and finished here rather than restarted; the rest (UI controls, the
Playwright e2e test) built fresh.

- **Daemon**: `POST /api/tasks/:tid/cancel` (`{run?}` -- a specific run,
  or every run `status.json` currently marks `"running"`), `.../resume`,
  `.../retry-run` (`{run}`, confirmed open question 2's semantics --
  clears that run's result file and every later step in the same round,
  letting the existing replay-from-files architecture re-enter it
  naturally, no bespoke one-off dispatch call needed).
- **What "resume" concretely means, confirmed by reading the code, not
  assumed**: genuinely distinct from `TaskRunner.reattachProject()`'s
  automatic restart-time reattach, which deliberately skips any
  terminal-phase task -- a `"stopped"`/`"failed"` task is *supposed* to
  stay stopped until a person says otherwise. `POST .../resume` is that
  deliberate signal: it rebuilds `DriveTaskParams` fresh from disk
  (`buildParams()` -> `rehydrateState()`) and restarts `driveTask()`,
  exactly like starting a brand-new task, just from a task that already
  has a lineup. Resuming a task stopped for a *file-backed* reason (gate
  failing after max rounds) replays into that same stopped conclusion
  again by itself -- a real no-op by design, not a bug; pairing it with
  `retry-run` first (which does change what's on disk) is what actually
  unsticks that case.
- **Two real bugs found and fixed in the cancel/resume/retry-run flow
  while getting the previous session's tests to actually pass** (not
  just typecheck -- they were still failing when picked up):
  1. **A race in the cancel route**: it killed the in-flight subprocess
     (`cancelRun()`, which polls up to every 200ms for the process to
     die) *before* signaling the loop's `AbortController` -- easily
     enough time for the killed dispatch's own promise to resolve and
     for `driveTask()`'s loop to race straight into dispatching the
     *next* command (gate, then verification) before the signal was ever
     set. First reproduced live (a cancelled task kept running gate and
     verification anyway), then fixed by signaling first, killing
     second -- the signal is synchronous and returns instantly, well
     before the kill's first `SIGTERM` even sends.
  2. **A deeper gap**: cancellation is a pure runtime signal with no
     corresponding `runs/*.result.json` file, so `rehydrateState()`'s
     file-replay (which `buildTaskDetail()` prefers over `state.json`'s
     own `phase` for every reason a task stops that replay can
     independently re-derive from the same files) has no way to ever
     learn a task was cancelled -- its `phase` looked stuck mid-round
     through the API forever. Fixed with a new, additive `TaskState`
     field (`stuck_reason`) that `drive.ts` now actually persists on
     cancellation, and `buildTaskDetail()` reads back to override
     replay's phase, but only when the daemon isn't actively driving the
     task and the on-disk phase disagrees with what replay thinks.
- **UI**: task-level Cancel (while active)/Resume (once stopped or
  failed)/"copy resume command" controls in the task-detail header, and a
  per-lane Retry button that only ever renders for a run that's actually
  retryable right now (the task's current round, task not active) rather
  than showing a control that would just 400. A real, in-app Resume
  button is a disclosed interpretation beyond the phase prompt's literal
  "cancel, retry, copy resume command" UI bullet -- the daemon's real
  `/resume` route would otherwise have no UI caller at all.
- **The Playwright e2e test -- this milestone's actual centerpiece, and
  the thing that caught the most significant bug found in this entire
  phase**: a new `e2e/full-flow.spec.ts`, with its own isolated daemon
  (own port, own `CREWBENCH_HOME`, own fake-`claude` override -- doesn't
  touch the existing shared fixture in `fixture-server.ts`/
  `global-setup.ts`, to avoid any risk to the already-passing
  `board-to-detail.spec.ts`), drives create -> a real two-turn scoping
  conversation -> finalize -> lineup -> a real fix round (developer,
  gate, tester, code-reviewer) -> a real commit approval, entirely
  through the real UI against a real daemon, with one fake CLI standing
  in for `claude` across every role (the phase prompt's own "fake CLIs"
  wording -- one was enough here since the fixture project's team
  defaults every role to `claude` and nothing about this flow is
  CLI-specific).
  - **A real, previously-invisible bug this test found live, not by
    inspection**: resolving the commit approval through the UI, the
    task-detail page's phase badge stayed on `"awaiting_commit"`
    forever, even though the daemon's own console genuinely logged
    `Committed <sha>.` / `<title>: done.` -- the commit and the finish
    both genuinely happened. Root-caused with a standalone repro script
    (bypassing the browser, hitting the daemon's HTTP API directly, and
    finally reading `state.json` straight off disk) before touching any
    code: `state.json`'s raw `phase` field genuinely said `"done"`, but
    `GET /api/tasks/:tid` kept reporting `"awaiting_commit"`, because
    `rehydrateState()`'s file replay (`resume.ts`) has *no branch at all*
    for "the commit approval was approved" -- that's an approval-flow
    decision, not something any `runs/*.result.json` file ever records,
    so replay's own ceiling for a completed task is "verification
    finished," never higher. This is the exact same class of gap as the
    cancellation bug above (replay blind to anything that isn't
    file-backed) -- my own earlier fix for cancellation only extended
    `buildTaskDetail()`'s on-disk-phase override to `"stopped"`/
    `"failed"`, not `"done"`, and missed this. **Every task that
    completes normally through a resolved commit approval hits this**,
    not an edge case -- it simply had no test before this milestone that
    resolved a real commit approval over HTTP and then re-checked the
    API's own reported phase afterward (`task-control.test.ts`'s own
    retry-run test reaches the same pending-commit-approval point but
    never resolves it). Fixed by extending the same on-disk-phase
    override to include `"done"`. Verified fixed with the same
    standalone repro script before touching the Playwright test at all,
    then confirmed via the real e2e test itself passing.
  - **Does not reach `integrate`** -- not a shortcut taken to make the
    test easier, the same real, disclosed gap milestone 5's own log
    already found: `integrate`/`cleanup_worktree` approvals only fire
    when `p.worktree && p.branch` are both set (`drive.ts`), and
    `TaskRunner.buildParams()` never sets either for an app-owned task --
    there is no worktree mode for one today. After the commit approval
    resolves, the loop finishes straight to `"done"`; there is no
    integrate step to reach without this milestone inventing worktree
    support it doesn't own. Confirmed by reading the code before writing
    the test, not discovered by the test failing to get there.
- Tests: `task-control.test.ts`'s three previously-failing tests (cancel,
  resume, retry-run -- all real subprocess-level, proving a genuine kill,
  a genuine re-entry into `driveTask()`, and a genuine re-dispatch
  respectively) now pass reliably (run 3x in a row); two more real,
  pre-existing test bugs found and fixed while getting there (not
  implementation bugs): `/resume` calls reused a shared `headers` object
  that always carried `Content-Type: application/json` even with no
  body, which Fastify's default JSON parser rejects outright
  (`FST_ERR_CTP_EMPTY_JSON_BODY`) -- a real gap in the test, not the
  route or the real client (`lib/api.ts`'s `apiFetch()` only sets that
  header `if (init.body ...)`); and a file-existence assertion checked
  the wrong directory (`taskDir`, the `.crewbench/tasks/<id>` metadata
  dir, instead of `repo`, the actual project root the fake CLI writes
  relative to -- app-owned tasks have no worktree, so `cwd` is the
  project root directly). New `task-controls.test.tsx` (8 tests) for the
  UI controls. New `full-flow.spec.ts` e2e test, run 3x standalone plus
  once alongside the existing e2e test to confirm no cross-file
  interference from its own isolated daemon/env handling.
- Full verification: `pnpm -r typecheck/build/test` all green (402 TS
  tests: 27 contract + 107 adapters + 152 engine + 67 daemon + 25 ui + 24
  cli), both Playwright e2e tests passing (run multiple times, reliably
  green), Python suite (212 tests) unaffected, `pnpm check:schemas`
  clean.
- **Honest assessment of Phase 3's overall goal ("make the UI a full
  replacement for the plugin workflow"), based on what was actually
  found while building this milestone, not a guess**: the *core* loop --
  create a task, scope it in a real chat with the lead, pick a lineup,
  watch a real fix round run, resolve approvals, and cancel/resume/retry
  -- is now genuinely real and daemon-hosted, proven end-to-end through
  the real UI by this milestone's own e2e test, not just unit-tested in
  isolation. That said, "full replacement" has real, disclosed gaps this
  phase leaves open, not hidden:
  1. **No worktree/branch isolation for app-owned tasks.** The plugin
     workflow's own worktree mode (isolated branch per task, `integrate`
     to bring it back, `cleanup_worktree` after) has no equivalent here
     at all -- every app-owned task runs in-place in the project root.
     A user who wants that isolation still needs the CLI/plugin.
  2. **Six of nine `ApprovalKind`s are still never actually issued**
     (milestone 5's own finding, unchanged by this milestone) --
     `confirm_profile`/`lineup` are real UI flows built on a *different*
     mechanism (milestone 4's own pages), `design` is decided outside
     `driveTask()` entirely, `dirty_tree`/`worktree_setup` are CLI-
     terminal pre-flight concepts that don't apply to a daemon-hosted
     task, and `push` has no implementation anywhere in this codebase.
  3. **An abandoned scoping conversation has no resume path** (milestone
     4's own disclosed gap, still true) -- a task left mid-scoping (spec
     never finalized) has nothing in the UI to pick that conversation
     back up.
  4. **Team settings only edits the role roster**, not `tiers`/`loop`/
     `workspace`/`confirm_lineup` (milestone 4's own disclosed scope
     limit, still true).
  None of these are new to this milestone -- they're the accumulated,
  honestly-disclosed scope limits from milestones 3-6 -- but "full
  replacement for the plugin workflow" is not yet a fully accurate claim
  with them still open. The core interactive loop this phase's own goal
  statement names first ("create a task, scope it... pick the lineup,
  then watch it run, answer approvals, and cancel, resume or retry") is
  genuinely done and proven; the plugin's own worktree-isolation
  workflow specifically is not replicated at all.
