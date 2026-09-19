# Phase 2 — Daemon + read-only UI

Status: **in progress** (reviewed and approved 2026-09-19; milestones 1-2 done)

Read first: `docs/app/CONTEXT.md`, `docs/app/contract/README.md`,
`docs/app/contract/events.md`, `docs/app/phase-1-plan.md`'s milestone
log (what actually shipped, including deviations), and the Phase 1
packages themselves (`contract`, `adapters`, `engine`, `cli`).

## Goal (unchanged from the phase prompt)

Run `crewbench ui` to start a local daemon and open a browser UI that
shows every crewbench task in registered projects — including tasks
started from the plugin inside Claude Code/Codex/Copilot/agy — with live
agent progress. Read-only this phase: no starting, cancelling or
approving tasks from the UI yet (that's Phase 3).

## What Phase 2 reuses from Phase 1, unchanged

- `packages/contract`'s zod schemas validate every API response — no new
  schemas needed for reading state, only new ones for API request/response
  envelopes not already covered (see Design decisions).
- `packages/engine`'s `loadState()`/`rehydrateState()`
  (`packages/engine/src/resume.ts`, milestone 6) already does the "read
  `.crewbench/` and reconstruct full state including the issue registry"
  work the daemon's task-detail endpoint needs — the daemon calls this,
  it doesn't reimplement it.
- The daemon **never writes** to `.crewbench/` this phase (read-only UI) —
  no runner, no git ops, no gate. It only watches, reads, and serves.

## Design decisions

1. **HTTP framework: Fastify.** Both Fastify and Hono are listed as
   options in `docs/app/CONTEXT.md`'s stack. Picking Fastify: mature SSE
   support via plugins, built-in schema validation hooks that compose
   well with zod (via `fastify-type-provider-zod`), and it's what most
   Node devs reaching for "a real HTTP server with plugins" expect —
   Hono's edge-first design buys nothing here since this only ever runs
   as a local Node process. Flagging for confirmation since
   `docs/app/CONTEXT.md` lists it as an "or."
2. **File watching: chokidar.** Not explicitly named in the stack list.
   Needed for "watch each project's `.crewbench/` ... with a robust file
   watcher, debounced" — chokidar is the de facto standard for
   cross-platform (including Windows) debounced watching with glob
   support, and multiple projects' trees need watching simultaneously.
   Listing it here per the working agreement's "new dependency needs a
   reason in the plan."
3. **In-memory index, not a database.** The phase prompt says "files stay
   the source of truth" — the daemon's in-memory index
   (`project -> tasks -> state summary`) is rebuilt from disk on startup
   (a full scan) and kept current by the watcher, never persisted itself.
   This also makes "killing and restarting the daemon mid-task loses
   nothing" (Definition of Done) trivially true for the read side: the
   next startup just re-scans.
4. **SSE replay via `Last-Event-ID`.** The `run.*`/`gate.*`/etc. events in
   `events.jsonl` already carry a monotonic `seq` per
   `docs/app/contract/events.md` — reusing `seq` as the SSE event id
   means a reconnecting client's `Last-Event-ID` header maps directly to
   "resume tailing `events.jsonl` from this seq," which is just re-reading
   already-buffered lines, not a new replay mechanism.
5. **Legacy (`schema_version` 0, plugin-only) task handling.** Per
   `docs/app/contract/events.md`'s "Legacy tasks" section (already
   documented from Phase 1 milestone 6's resume work): no `events.jsonl`
   at all. The daemon's watcher treats a missing `events.jsonl` as "no
   live event stream, state.json polling only" rather than an error — the
   task still appears on the board and in task detail with whatever
   `state.json`/`status.json` has, and the UI labels the gaps (no
   agent-lane live stream) instead of crashing. This is the same
   "graceful, not silent-failure" contract Phase 1 already established
   for legacy tasks.
6. **UI stack scope for this phase.** `docs/app/CONTEXT.md` names React +
   Vite + TanStack Query + TanStack Router + Tailwind + shadcn/ui, and a
   diff viewer component. Adding here, since they're new to `app/`:
   TanStack Query for all data fetching + SSE-driven cache updates,
   TanStack Router for the 5 screens listed in the phase prompt, Tailwind
   v4 (CSS-first config, current stable) + shadcn/ui for components, and
   `react-diff-view` (or `diff2html`, TBD at milestone 5 when the diff tab
   is actually built — not deciding now since it's not needed until then)
   for the diff viewer.
7. **Auth token delivery.** The phase prompt: "`crewbench ui` opens the
   browser with the token, and the UI keeps it in memory." Concretely:
   the token is a URL fragment (`http://127.0.0.1:<port>/#token=<token>`),
   never a query param — fragments aren't sent to the server or logged in
   access logs/browser history the same way, and the UI's bootstrap JS
   reads it once from `location.hash`, strips it from the URL via
   `history.replaceState`, and holds it in memory (a module-level
   variable, not `localStorage` — the token is per-daemon-process-life,
   and persisting it would let a stale token outlive a daemon restart).
   Every subsequent API call sends it as `Authorization: Bearer <token>`.

## Milestones

Mapped 1:1 to the phase prompt's own list, each ending in its own
commit(s), passing tests, and a note appended below.

### 1. Daemon skeleton + auth token + project registry + task listing API

- `packages/daemon`: Fastify app, binds `127.0.0.1` only (never
  `0.0.0.0`, asserted with a test that inspects the actual listen
  address). Configurable port via `--port`/`config.json`, falls back to
  the next free port if the default is busy (matching the phase prompt's
  "pick a fixed one, and fall back if it is busy").
- Auth: random token (crypto-strong, `node:crypto`'s `randomBytes`)
  generated at daemon startup, held in memory only. A Fastify
  `onRequest` hook rejects any request missing/mismatching
  `Authorization: Bearer <token>` with 401, **and** checks the `Origin`
  header against `http://127.0.0.1:<port>`/`http://localhost:<port>`,
  rejecting anything else with 403 (defends against a malicious page on
  another origin making authenticated requests via a leaked token, and
  against DNS-rebinding-style attacks).
- Project registry: `~/.crewbench/projects.json` — zod schema in
  `packages/contract` (new: no Python equivalent exists, this is an
  app-only file, never read by the plugin). `POST /api/projects` and
  `DELETE /api/projects/:pid` validate the path is an existing git repo
  (`git rev-parse --is-inside-work-tree`) before adding.
- `GET /api/projects`, `GET /api/projects/:pid/tasks` — the latter reads
  `.crewbench/index.json` per project (already the plugin's existing
  index file, per `docs/app/contract/README.md`) rather than scanning
  `tasks/*/state.json` individually, for the same reason
  `crewbench_state.py list` does today: `index.json` is the fast path,
  full state is loaded lazily per task.
- Every response shape gets its own new zod schema in
  `packages/contract` (API envelopes, not just the existing file
  schemas) so `fastify-type-provider-zod` can validate on the way out —
  catches a daemon bug serializing something schema-invalid before a
  client ever sees it.

### 2. Watchers + events tail + SSE with replay + tests

- `packages/daemon`'s watcher layer: one chokidar watcher per registered
  project's `.crewbench/` tree, debounced (matching the phase prompt),
  updating the in-memory index on `index.json`/`state.json`/`status.json`
  changes.
- `events.jsonl` tailing: track a byte offset per task, read only the
  newly appended bytes on each change event (not the whole file), parse
  complete lines (buffering a trailing partial line until the next read)
  — this is the piece that has to be correct under concurrent writes
  from a real running crewbench process, so it's tested against a real
  file being appended to mid-read, not just a static fixture.
- `GET /api/tasks/:tid/events` (per-task SSE) and `GET /api/events`
  (global, task-level events only — task created/phase changed/task
  done, not full per-run event noise) both support `Last-Event-ID` replay
  per Design decision 4.
- Tests: simulate a plugin writing files (spawn a real background process
  appending to a fixture `events.jsonl` and touching `state.json`, same
  "real subprocess, not a mock" standard Phase 1 held itself to for
  cross-compat), assert the SSE client receives the right sequence, and
  assert a reconnect with `Last-Event-ID` gets exactly the missed events,
  no duplicates and no gaps.

### 3. UI shell, routing, theming, projects page, live task board

- `packages/ui`: Vite + React + TanStack Router scaffold, Tailwind v4 +
  shadcn/ui base components, dark/light theme (`prefers-color-scheme`
  default, explicit toggle persisted in `localStorage` — a per-viewer
  convenience, not state the daemon needs to know about).
- Bootstrap: reads the token from `location.hash` per Design decision 7,
  a TanStack Query client configured to attach it to every request and
  to an `EventSource`-equivalent SSE client (native `EventSource` can't
  send custom headers, so this needs a small wrapper — either the token
  as a one-time-use query param on the SSE connection specifically,
  scoped to that endpoint only and short-lived, or a fetch-based SSE
  polyfill; deciding the exact mechanism at milestone 3, not guessing
  now).
- **Projects** screen: cards (active/recent task counts), "add project"
  dialog (path input, calls the milestone-1 validation endpoint, surfaces
  the exact git-repo-check failure if it fails).
- **Task board**: columns by phase (`scoping, design, implementing,
  verifying, fixing, awaiting_commit, done, stopped, failed` — matching
  `schemas/task-state.json`'s enum exactly, same as the engine's phases),
  live via the global SSE stream from milestone 2. Cards: title, round
  `N/max`, role avatars with live status dots, Jira key if present,
  elapsed time.

### 4. Task detail: header, rounds timeline, agent lanes (live)

- `GET /api/tasks/:tid` (state + spec + rounds + usage, assembled server-
  side from `rehydrateState()`'s output) and `GET
  /api/tasks/:tid/runs/:run/log?from=offset` (raw log tail, same
  offset-based incremental read as the events tailer).
- Task detail header: title, phase, round, branch/worktree, base commit,
  lineup chips (role → cli · model · effort · permissions — reads
  straight off `state.json.lineup`, already contract-shaped).
- Rounds timeline: per round, gate result per step, tester/reviewer lanes
  side by side, verdict (fix list sent / approved / stuck) — this is
  effectively `docs/app/contract/README.md`'s round-data shape rendered,
  not new data modeling.
- Agent lanes: one per run, live event stream via the per-task SSE
  endpoint (filtered client-side to that run), auto-scroll lock, raw log
  toggle (falls back to the `/log` endpoint), duration, usage line, copy
  resume-command button.

### 5. Issues/failures tables, diff viewer, spec/screenshots tabs, warnings

- `GET /api/tasks/:tid/diff?round=N|base`: unified diff vs `base_commit`
  or a round's delta, computed via `git diff` in the project's worktree
  (or main tree if the worktree was already removed — same "read from
  wherever the git history actually is" the engine's own git-safety
  snapshots already handle, just read-only here).
- Issues table (every issue across rounds, severity, file:line, category,
  per-round status, below-threshold flag) and test-failures table read
  straight from the issue registry `rehydrateState()` already
  reconstructs (Phase 1 milestone 3's work) — no new server-side logic,
  just serializing it.
- Diff tab (file tree + diff viewer, vs-base/round-delta toggle), spec
  tab (acceptance criteria/scope/out-of-scope from the task-spec), and
  screenshots tab (shown conditionally, only when a round produced any —
  ui-ux/visual-verification artifacts, per `docs/app/contract/README.md`).
- Warnings banner: surfaces the git-safety warnings
  (`docs/app/phase-1-plan.md`'s milestone 4 git-ops work already
  generates these — HEAD moved, branch switched, stash changed, etc.)
  prominently, not buried in a log.

### 6. Health + usage pages; polish; empty/loading/error states

- `GET /api/doctor`: runs every adapter's `doctor()` for all four CLIs,
  cached (doctor does real network/auth calls per Phase 1's adapters —
  don't re-run on every page load; cache with a short TTL and a manual
  refresh button).
- Health page: doctor results per CLI, exact fix hint per failure (reuses
  the adapters' own hint strings, doesn't reinvent them).
- Usage page: per task and per role — runs, duration, tokens/cost where
  known; unknown values render as `—`, never `0` (the phase prompt is
  explicit about this — a `0` reads as "confirmed zero cost," which is
  false when a CLI just doesn't report cost, per this repo's existing
  `cost_usd: null` convention from Phase 0).
- Empty/loading/error states audited for every screen built in
  milestones 3–5 (no screen ships this milestone without all three), plus
  the legacy-task degraded-view states from Design decision 5.

## Files touched (new, this phase)

`app/packages/daemon/` (new package), `app/packages/ui/` (new package),
`app/packages/contract/` (new API-envelope schemas + `projects.json`
schema — additive, no changes to existing file schemas),
`app/packages/cli/src/commands/ui.ts` (new `crewbench ui` command),
`docs/app/contract/README.md` (document `~/.crewbench/projects.json` and
`~/.crewbench/config.json` if milestone 1 needs a port/config file — see
open question 3). No existing `bin/*.py`, `schemas/*.json`,
`lib/dispatch.md` or `skills/*/SKILL.md` changes — same "reads the
plugin's behavior as spec, doesn't modify it" boundary as Phase 1.

## Open questions

1. **Playwright for the smoke test (Definition of Done item 3).** Not
   currently a dependency anywhere in `app/`. Proposing to add it
   scoped to `packages/ui` only (dev dependency), per the working
   agreement's "new dependency needs a reason" — needed specifically for
   the one board → task detail smoke test the Definition of Done
   requires; not proposing broader e2e UI coverage this phase beyond
   that one flow plus the two named unit tests (rounds timeline, issues
   table).
2. **Component test framework for React.** `docs/app/CONTEXT.md`'s stack
   list doesn't name one. Proposing Vitest (already the workspace
   standard) + `@testing-library/react`, the standard pairing and the
   least-new-tooling option given vitest is already everywhere else in
   `app/`.
3. **Where does the daemon's own port/config live?** The phase prompt
   only mentions `~/.crewbench/projects.json` explicitly. Proposing
   `~/.crewbench/config.json` now for the port (Phase 4's prompt already
   plans to put "port, per-CLI concurrency limits, default lineup,
   notification preferences" there) rather than inventing a separate
   file this phase and migrating later — milestone 1 only needs the
   `port` field, but the file's shape should already anticipate Phase
   4's fields so it's additive, not a breaking rewrite. Flagging since
   it means Phase 2 lightly pre-shapes a Phase 4 file.
4. **`GET /api/events`'s definition of "task-level."** The phase prompt
   says "global task-level events for the board," distinct from the
   per-task full event stream. Proposing: only `task.created`,
   `task.phase_changed`, `run.started`/`run.finished` (state-changing at
   the board-card level), and `approval.requested` — filtering out
   `run.message`/`run.tool_call`/`run.tool_error` (per-token/per-tool-call
   noise, only relevant inside a specific agent lane). Needs the
   `docs/app/contract/events.md` catalog checked against this list before
   milestone 2 starts, since a `task.*`-prefixed event type doesn't exist
   yet in the catalog — it's task-summary-level, synthesized by the
   daemon itself from watching `state.json`/`index.json` changes, not
   read from any single task's `events.jsonl` (which has no task-level
   "phase changed" event of its own, only per-run events). Confirming
   this is meant to be a daemon-synthesized stream, not a new contract
   event type, before building it.

## Milestone log

### Milestone 1 — done (2026-09-19)

- New `packages/daemon` package (Fastify 5, per Design decision 1).
  Binds `127.0.0.1` only, asserted by a test that reads back the actual
  listening address (never trusts the bind call alone). Port resolution
  (`port.ts`): tries the preferred port (default 4287, or
  `~/.crewbench/config.json`'s `port`, or `--port`), scans upward if
  busy, and a `preferred === 0` sentinel resolves an OS-assigned
  ephemeral port up front — needed because the auth hook's Origin
  allowlist has to know the concrete port *before* the server starts
  accepting connections, so Fastify's own `listen({port: 0})` (which
  would only reveal the real port *after* binding) couldn't be used
  directly for that case.
- Auth (`auth.ts`): a random 32-byte token generated fresh in memory at
  startup (never persisted). Every request needs `Authorization: Bearer
  <token>` (constant-time compared via `timingSafeEqual`, not `===` — a
  timing side-channel is low-stakes on a loopback server but cheap to
  close) and, when an `Origin` header is present at all, it must match
  `http://127.0.0.1:<port>` or `http://localhost:<port>` exactly.
- Project registry (`registry.ts`): `~/.crewbench/projects.json`
  (`CREWBENCH_HOME`-overridable for tests, mirroring `CREWBENCH_ROOT`'s
  existing override pattern), a new app-only zod schema in
  `packages/contract` (`registry.ts` — `RegisteredProject`,
  `ProjectsRegistry`) since there's no Python-side file to port from.
  `addProject()` validates the path is a real git repo (`git rev-parse
  --is-inside-work-tree`) before writing, resolves it to absolute first,
  and re-adding the same path updates the existing entry rather than
  duplicating it.
- Routes (`routes/projects.ts`): `GET/POST /api/projects`, `DELETE
  /api/projects/:pid`, `GET /api/projects/:pid/tasks` — the last one
  calls `packages/engine`'s existing `listTasks()` against the project's
  `.crewbench/index.json`, unchanged from what the CLI's own `status`
  command already reads. Every response is `.parse()`d against a new
  `packages/contract` API-envelope schema (`api.ts` —
  `ApiProjectListSchema`, `ApiTaskListSchema`) before being sent, per the
  milestone's own design decision — this is deliberately manual
  (`Schema.parse()` before `reply.send()`) rather than wired through
  `fastify-type-provider-zod`: it gives the identical "every response is
  schema-validated" guarantee with one fewer dependency, so that package
  was dropped from `package.json` after prototyping showed it wasn't
  needed for this milestone's actual route shapes (listed in the plan,
  removed once redundant — noting the deviation, not silently).
- **Caught one real bug via a failing test**: the first version of
  `ApiTaskSummarySchema` was `.strict()` and didn't include
  `schema_version` — `packages/engine`'s `listTasks()` index rows
  (`indexEntry()` in `task-store.ts`) always carry that field, so every
  real `GET /api/projects/:pid/tasks` call 500'd on
  `unrecognized_keys`. Fixed by switching to `.catchall(z.unknown())`,
  which is also the more correct shape per Design decision 5 (a legacy
  or future-version index entry may carry fields this schema doesn't
  know about yet — the daemon should serve those gracefully, not 500).
- `crewbench ui [--port N] [--no-open]` (`packages/cli/src/commands/ui.ts`):
  starts the daemon, prints and (unless `--no-open`) opens
  `http://127.0.0.1:<port>/#token=<token>` — a URL fragment, not a query
  param, per Design decision 7 (never sent to the server or logged
  anywhere a query param would be). `SIGINT`/`SIGTERM` close the daemon
  before exiting.
- Verified live, not just via the fake-CLI-free test suite: ran the real
  built `crewbench ui --no-open` binary, then `curl`'d the real listening
  daemon directly — confirmed 401 (no token), 401 (wrong token), 403
  (valid token + wrong Origin), and a real `POST /api/projects` against
  this actual repo, all producing the expected real HTTP responses.
- Full verification: `pnpm -r typecheck/build/test` all green (315 TS
  tests: 25 contract + 107 adapters + 150 engine + 9 daemon + 24 cli);
  Python suite (212 tests) unaffected and still green; `pnpm
  check:schemas` still reports no drift (the new contract schemas aren't
  in the generator's target list — API/registry shapes have no
  Python-side file to generate).

### Milestone 2 — done (2026-09-19)

- `tail.ts`: incremental byte-offset reads of `events.jsonl` -- only the
  bytes appended since the last read, split into complete lines with a
  possibly-partial trailing line buffered for next time (the same "torn
  line from a crash mid-write" tolerance `events.md` already documents,
  extended to mid-write reads too). Each complete line is parsed and
  validated against the existing `CrewbenchEventSchema` discriminated
  union from `packages/contract` (Phase 0's port); a malformed line is
  skipped, not thrown, so one bad line can never wedge the tail.
- `watcher.ts`: one chokidar watcher per registered project's
  `.crewbench/` tree (`awaitWriteFinish` for the phase prompt's own
  "debounced"), maintaining an in-memory task-id -> project/taskDir index
  (Design decision 3) built from `index.json` and kept current whenever
  it changes -- confirmed live that chokidar picks up a `.crewbench/`
  directory that doesn't exist yet at watch-start (the common case for a
  freshly registered project with no tasks), including nested
  `tasks/<id>/{state.json,events.jsonl}` appearing together, via a
  standalone script before trusting it in the daemon.
- **Design correction, not silently**: `docs/app/phase-2-plan.md`'s own
  open question 4 proposed including `approval.requested` in the global
  board feed's event-type allowlist. This milestone confirmed that event
  type is never actually written to any `events.jsonl` anywhere in this
  codebase -- Phase 1's approvals are resolved purely in-memory via
  terminal prompts, with no persisted event. Dropped from
  `GLOBAL_EVENT_TYPES`; the allowlist is `task.created`,
  `task.phase_changed`, `task.round_started`, `run.started`,
  `run.finished`.
- `sse.ts` + `routes/events.ts`: `GET /api/tasks/:tid/events` (per-task,
  replay-then-live) and `GET /api/events` (global, task-level only).
  Per-task replay is disk-based and correct across a daemon restart
  (files stay the source of truth); the global feed's replay buffer is
  in-memory only, capped at 500 entries, and does **not** survive a
  restart -- documented in `watcher.ts` rather than left implicit, since
  the board's own initial paint comes from the milestone-1 REST listing
  endpoints, not this stream. Both connect-then-subscribe in a specific
  order (subscribe to live events first, buffer them, *then* read the
  disk replay snapshot, then flush the buffer filtering out anything
  already covered by the replay) so an event landing exactly at connect
  time is never dropped or double-sent.
- Tests (`test/watcher-sse.test.ts`): a real subprocess-free but
  real-disk simulation -- `packages/engine`'s own `createTask()`/
  `appendEvent()` write real files while a real running daemon's real
  chokidar watcher observes them (the phase prompt's "simulate a plugin
  writing files, and assert the SSE output," satisfied with the app's own
  file-writing functions standing in for the plugin's, since both write
  byte-identical files). Covers: live tailing, 404 on an unknown task id,
  exact-replay-no-duplicates-no-gaps on a `Last-Event-ID` reconnect, and
  the global feed's type filtering.
- **Caught one real bug, in the test helper, not the daemon** (confirmed
  by hand against the real built daemon with a standalone script before
  concluding this): the first version of the tests' SSE-reading helper
  raced each `reader.read()` against a short per-iteration `sleep()` and,
  on a timeout, looped back and issued a *second* concurrent `read()`
  while the first was still outstanding -- `Promise.race()` only returns
  whichever settles first and discards the other's already-consumed
  value, so a chunk that arrived just after one slice's timeout won was
  silently thrown away. Fixed by never having more than one `read()`
  outstanding at a time, raced only against a single whole-call deadline.
- Fastify's `close()` needed `forceCloseConnections: true` -- an open SSE
  stream is by design a long-lived keep-alive connection, and without
  this flag `close()` waits for it to end on its own (which it may not,
  if a client abort hasn't fully propagated to the socket), hanging
  daemon shutdown. Caught via a real `afterEach` hook timeout, not
  inspection.
- Full verification: `pnpm -r typecheck/build/test` all green (319 TS
  tests: 25 contract + 107 adapters + 150 engine + 13 daemon + 24 cli);
  Python suite (212 tests) unaffected; `pnpm check:schemas` still reports
  no drift.
