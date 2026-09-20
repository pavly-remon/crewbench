# Phase 3 — Interactive UI (create, scope, approve, control)

Status: **in progress** (reviewed and approved 2026-09-19: design decisions 1-3 and open questions 1-3 confirmed with the recommended approach; milestones 1-2 done; milestone 3 implemented, pending human review -- see its log entry)

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

### Milestone 3 -- implemented, pending human review (2026-09-20)

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
