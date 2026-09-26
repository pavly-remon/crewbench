# Phase 0 — Harden the contract (Python plugin side)

Status: **draft — awaiting review**

Read first: `docs/app/CONTEXT.md`, `bin/crewbench_state.py`,
`bin/crewbench_dispatch.py`, `schemas/task-state.json`, `lib/dispatch.md`
§0 and §4, `skills/status/SKILL.md`, `skills/resume/SKILL.md`.

## Current-state findings (why each milestone is needed)

- **Race window in `crewbench_state.py`.** `load_state` → mutate → `save_state`
  happens with no lock held across the whole thing. `save_state` writes
  `state.json` (via `_atomic_write`, itself lock-then-write) and then does a
  separate `_update_index` read-modify-write of `index.json` under its *own*
  lock. Two concurrent `crewbench_state.py set ...` calls (e.g. tester and
  reviewer runs both updating `state.json.rounds` at once) can each read the
  same pre-mutation state, then both write, and one update is silently lost.
  `crewbench_dispatch.py`'s `update_status` (for `status.json`) already does
  this correctly: open the lock file, take the lock, read, merge, write,
  unlock — one critical section for the whole read-modify-write. That's the
  pattern to copy.
- **Duplicated lock code.** `_lock_file`/`_unlock_file` live in
  `crewbench_dispatch.py`, and `crewbench_state.py` imports them by reaching
  into dispatch's module — a backwards dependency (the state helper importing
  from the dispatch script) that the plan removes by extracting both
  functions into a new `bin/crewbench_fs.py`.
- **Timestamps are naive local time**, via `time.strftime("%Y-%m-%dT%H:%M:%S")`
  in three places (`crewbench_state.py:now_iso`, and
  `crewbench_dispatch.py`'s `cmd_cancel` and two spots in `main`). No offset,
  not UTC — a daemon comparing timestamps across machines/timezones can't
  trust ordering.
- **Task ids collide by construction.** `make_task_id` is
  `YYYYMMDD-HHMM-<slug>`, minute resolution, slug truncated to 5 words — two
  tasks started in the same minute with a similar description collide and
  silently overwrite each other's directory.
- **No schema version anywhere.** `state.json`, `index.json`,
  `status.json`, and the result envelope all lack a version field, so a
  future reader (the app) can't tell a legacy file from a current one.
- **No structured event stream.** Everything observable today is either the
  human-readable `.log` file or the final `.result.json` — there's no
  append-only, per-task, structured record a daemon could tail. This is the
  biggest single addition in this phase.
- **Codex/Copilot usage/events.** `lib/dispatch.md`'s "Usage and timing"
  section already documents that codex/copilot usage is `VERIFY`
  (best-effort text scan, unconfirmed live) — milestone 4 is real
  investigation against the installed CLIs' `--help`, not a guess.
- **Root test.** `tests/test_dir_writable.py::test_nonexistent_dir_under_a_read_only_ancestor_is_not_writable`
  already skips on Windows; it needs the same treatment for `root` (CI
  sometimes runs containers as root, where chmod 0o500 is ignored).

## Design decisions

1. **New module `bin/crewbench_fs.py`** holds `_lock_file`, `_unlock_file`,
   and a new `locked_read_modify_write(path, mutate_fn)` helper that both
   `crewbench_state.py` and `crewbench_dispatch.py` use. `crewbench_dispatch.py`
   re-exports or imports from it so nothing that currently does
   `from crewbench_dispatch import _lock_file` breaks — grep first to confirm
   nothing outside these two files imports the old names.
2. **Lock granularity for state.json + index.json together.** `set`/`append`
   need one critical section spanning *both* files, since `_update_index`
   derives from the just-written state. Take the `state.json` lock, then
   (still inside it) take the `index.json` lock, do both writes, release in
   reverse order. Document the fixed lock order (state before index) so nothing
   else can deadlock by taking them in the opposite order.
3. **Event log dir layout.** `.crewbench/tasks/<id>/events.jsonl`, one lock
   file `.crewbench/tasks/<id>/.events.lock`, `seq` tracked by reading the
   last line's `seq` under the same lock (not a separate counter file — one
   less thing to desync).
4. **Event emission points**: `crewbench_state.py` emits `task.created` (in
   `cmd_new`), `task.phase_changed` (in `cmd_set`/`cmd_append` when the key is
   exactly `phase`), `task.round_started` (when `round` changes),
   `task.note_added` (when appending to `notes`). `crewbench_dispatch.py`
   emits `run.started`/`run.finished`/`gate.finished`/`git.warning` — gate
   emission happens via a small helper `crewbench_gate.py` can call, since
   gate results currently get folded into `state.json.rounds` by the Team
   Lead, not written by the gate script itself; `run.message`/`run.tool_call`/
   `run.tool_error` are emitted by the `Stream` class as it parses each line,
   alongside (not replacing) the existing `.log` write.
5. **Legacy compatibility.** Old task ids (no hex suffix) and old naive
   timestamps keep parsing — add a `parse_legacy_or_utc()` helper in
   `crewbench_fs.py` that readers use instead of assuming a format.
   `schema_version` missing → treated as `0` wherever it's read.
6. **No TypeScript, no workflow changes, no UI** — confirmed out of scope per
   the phase prompt; this plan only touches `bin/*.py`, `schemas/*.json`,
   `tests/*.py`, and `docs/app/contract/*`.

## Milestones

1. **Shared fs/lock module + race-free state/index writes + concurrency tests.**
   - Add `bin/crewbench_fs.py` with `_lock_file`, `_unlock_file`,
     `locked_read_modify_write`.
   - `crewbench_dispatch.py` imports from it (keep `update_status` working
     unchanged, just re-pointed at the shared functions).
   - `crewbench_state.py` imports from it instead of from `crewbench_dispatch`.
   - Rewrite `save_state`/`_update_index` so `set`/`append`/`new` hold one
     lock across load → mutate → write for state.json, and the index.json
     read-modify-write happens inside the same critical section.
   - New `tests/test_fs_lock.py`: spawn N subprocesses each doing
     `crewbench_state.py set ...` against the same task dir with distinct
     keys, assert all N keys are present afterward (no lost update) for both
     `state.json` and `index.json`.

2. **UTC timestamps + collision-proof ids + schema_version (with legacy reads).**
   - `now_iso()` → `datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")`
     in `crewbench_fs.py`; update the two `time.strftime(...)` call sites in
     `crewbench_dispatch.py` to use it.
   - `make_task_id`: append `-<4 hex>` from `secrets.token_hex(2)`.
   - Add `schema_version: 1` to `cmd_new`'s initial state, `_update_index`'s
     index entries, `update_status`'s per-run entries, and the envelope dict
     in `crewbench_dispatch.py`'s `main`.
   - Add `parse_legacy_or_utc()` and use it anywhere `status`/`resume`
     compares timestamps.
   - Update `schemas/task-state.json`, `schemas/*.json` (result envelopes) to
     document `schema_version` as optional (defaults to `0`).
   - Tests: id-collision test (two ids from the same text in the same minute
     differ), legacy-timestamp parse test, missing-schema_version read test.

3. **events.jsonl writer + event emission + docs.**
   - `crewbench_fs.py`: `append_event(task_dir, type, data, run=None)` —
     locks `.events.lock`, reads last line for `seq`, writes the new line,
     unlocks.
   - Wire emission points listed in Design decision 4.
   - `docs/app/contract/events.md`: every event type, its `data` shape, and
     which component writes it.
   - Tests: concurrent-writer test (two processes appending events at once,
     assert monotonic gapless `seq` and no interleaved partial lines);
     one test per emission point (state phase/round/note change → correct
     event; a fake dispatch run → `run.started`/`run.finished`).

4. **Codex/Copilot structured-output investigation.**
   - Run `codex exec --help` and `copilot --help` (actual installed
     binaries on this machine) and read for a JSON/JSONL event mode.
   - If found: add a parser to `Stream`, a recorded fixture in
     `tests/fixtures/`, and a test asserting it extracts session id,
     messages, tool calls, errors, and real token usage.
   - If not found: record CLI name + version + the `--help` evidence in
     `docs/compatibility.md`, keep the existing text-scan fallback, and
     leave `usage.total_tokens` etc. as `VERIFY`/`null` — no behavior change.
   - This milestone's outcome is genuinely unknown until the investigation
     runs; the plan can't pre-commit to "add a parser" vs. "record findings"
     for either CLI.

5. **Contract README + CHANGELOG + version bump.**
   - `docs/app/contract/README.md`: full `.crewbench/` layout, every file,
     writer, reader, schema — written last, once every other milestone's
     shape is settled, since it documents the final state.
   - `CHANGELOG.md` entry under a new "Unreleased" or dated section
     (matching the existing file's convention — check it first).
   - `python3 scripts/bump_version.py` (check its usage first via
     `--help`/reading it) to bump the plugin version for this change.

## Files touched

- New: `bin/crewbench_fs.py`, `tests/test_fs_lock.py`,
  `docs/app/contract/README.md`, `docs/app/contract/events.md`
- Modified: `bin/crewbench_state.py`, `bin/crewbench_dispatch.py`,
  `bin/crewbench_gate.py` (small hook to emit `gate.finished`),
  `schemas/task-state.json`, other `schemas/*.json` result envelopes,
  `tests/test_dir_writable.py`, `tests/test_state_helper.py`,
  `tests/test_detached_dispatch.py` (whatever already asserts on
  `status.json`/envelope shape needs updating for `schema_version`),
  `docs/compatibility.md`, `CHANGELOG.md`
- Possibly modified: `tests/conftest.py` if fixtures need a `crewbench_fs`
  import alongside the existing `dispatch` fixture.

## Open questions

1. ~~Event emission for gate results.~~ **Resolved in milestone 3:**
   `crewbench_gate.py` already takes `--task-dir`/`--round`, so no interface
   change was needed — `run_gate()` calls `append_event()` itself right
   after writing `gate-r<n>.result.json`.
2. **Do old-format task ids (no hex suffix) need a migration, or just
   read-compatibility?** The phase prompt says "old ids must keep working
   everywhere" — read this plan as read-compatibility only, no rewrite of
   existing task directories. Confirm that's the intent.
3. ~~`run.tool_call`/`run.tool_error` granularity.~~ **Resolved in milestone
   3, smaller than feared:** rather than adding a second, typed parsing path
   through each CLI's raw output, `classify_log_entry()` matches on the
   fixed textual prefixes `Stream.feed()` already normalizes every CLI's
   tool/message/error lines into (`"tool: "`, `"  error:"`, plain text) —
   one ~10-line classifier covers all four CLIs, at the cost of `data.text`
   being the same free-form string as the `.log` line rather than
   structured fields (tool name, arguments). Documented as a known
   limitation in `docs/app/contract/events.md`'s `run.tool_call` section —
   a future phase wanting structured per-call fields would need to change
   `Stream.feed()`'s return value itself, not just this classifier.

## Milestone log

### Milestone 1 — done (2026-09-19)

- Added `bin/crewbench_fs.py`: `_lock_file`/`_unlock_file` (moved out of
  `crewbench_dispatch.py` unchanged), `locked_read_modify_write`,
  `atomic_write_json`, `read_json_or_default`.
- `crewbench_dispatch.py` now imports the lock functions from
  `crewbench_fs`; `update_status`'s behavior is unchanged.
- `crewbench_state.py` rewritten around a single `mutate_state(task_dir,
  mutate_fn)` used by `new`/`set`/`append`. It takes **two** nested locks,
  not one: the per-task `.state.json.lock` (serializes concurrent writers on
  the *same* task), then — still inside it — the shared `.index.json.lock`
  under the `.crewbench` root (serializes concurrent writers on *different*
  tasks that all touch the same `index.json`). Lock order is always
  state-then-index, so no cross-task deadlock is possible.
  - Caught during implementation: an initial version locked only the
    per-task state lock and let `index.json`'s read-modify-write run
    unlocked across tasks — safe for one task at a time but not across
    tasks, since every task shares the same `index.json`. Added
    `test_concurrent_writes_to_different_tasks_all_land_in_index` specifically
    to catch this before it shipped; the two-lock fix makes it pass.
- New `tests/test_fs_lock.py`, three tests, each spawning 12 real
  `crewbench_state.py` subprocesses concurrently (via `ThreadPoolExecutor`
  driving `subprocess.run`, so the OS-level `flock`/`msvcrt.locking` is
  actually exercised, not an in-process mock):
  1. concurrent `set` calls on 12 distinct keys of the same task — all land.
  2. concurrent `append` calls on the same task's `notes` list — all land,
     none duplicated.
  3. concurrent `new` calls creating 12 different tasks under the same
     root — all land in the shared `index.json`.
- Full suite: 188 passed (185 pre-existing + 3 new), no regressions.
- Also fixed a stale comment in `crewbench_gate.py` pointing at the old
  `crewbench_dispatch.py` location of `_lock_file`/`_unlock_file`.

### Milestone 2 — done (2026-09-19)

- `crewbench_fs.py` gained `SCHEMA_VERSION = 1`, `now_iso()` (UTC ISO-8601
  with an explicit `Z` offset), and `parse_legacy_or_utc()` (parses either
  the new UTC format or the old naive-local one into a comparable
  timezone-aware `datetime`, returning `None` for anything unparseable).
- `crewbench_state.py`: dropped its own local `now_iso()` in favor of the
  shared one; `make_task_id` now appends `-<4 hex>` via `secrets.token_hex(2)`;
  `cmd_new`'s initial state and `_index_entry()` both carry
  `schema_version`; `cmd_list`'s sort now parses timestamps instead of
  comparing raw strings, so old naive-local and new UTC entries interleave
  correctly and unparseable/missing timestamps sort last.
- `crewbench_dispatch.py`: the three structured `time.strftime(...)`
  timestamp sites (`cmd_start`, the `finish()` closure, and the
  pre-run `update_status` call) now use `now_iso()`; each of those
  `update_status` calls also carries `schema_version`. `now()` (the
  human-facing `[HH:MM:SS]` log-line prefix) is intentionally untouched —
  the phase prompt allows local time there.
- `schemas/task-state.json` documents `schema_version` (optional, missing
  means legacy version 0) and the new id shape.
- `lib/dispatch.md` §0's id format updated to match.
- Updated `tests/test_state_helper.py::test_make_slug_and_task_id` for the
  new id shape (it previously asserted an exact `-hello-world` suffix,
  which no longer holds now that a hex suffix follows it) and added a
  same-minute-collision test next to it.
- New `tests/test_schema_version_and_timestamps.py` (7 tests): UTC format
  of `now_iso()`, new tasks carry `schema_version` in both `state.json` and
  `index.json`, a hand-written legacy `state.json` (no `schema_version`,
  naive timestamp) still reads *and* can still be `set` against without
  crashing, `parse_legacy_or_utc()` on both formats plus `None`/garbage
  input, `list`'s sort ordering across legacy/UTC/garbage timestamps, and
  id non-collision.
- Full suite: 195 passed, no regressions.

### Milestone 3 — done (2026-09-19)

- `crewbench_fs.py` gained `append_event(task_dir, event_type, data,
  run=None)`: locks `.events.lock`, computes the next `seq` by reading the
  last line of `events.jsonl` (`_last_seq()`, tolerant of a torn last line
  from a crash mid-write), appends one JSON line, releases. `EVENTS_FORMAT_VERSION
  = 1` is the line shape's own `v` field, deliberately separate from
  `schema_version` (which versions `state.json`/`index.json`/`status.json`/
  the envelope, not the event log).
- `crewbench_state.py` emits `task.created` (`new`), `task.phase_changed`
  and `task.round_started` (`set`, only when the key is exactly `phase`/
  `round` *and* the value actually changed — setting the same phase again
  emits nothing), and `task.note_added` (`append --key notes`). Captures
  the pre-mutation value inside the `mutate_state()` closure so the "did it
  actually change" check sees the real old value, not a guess.
- `crewbench_dispatch.py` emits `run.started` (right before spawning),
  `run.finished` (in `finish()`, covering every exit path including
  early-return errors like "CLI not installed"), `git.warning` (one event
  per warning string from `git_changes()`), and `run.message`/
  `run.tool_call`/`run.tool_error` for every line `Stream.feed()` produces
  while the role's process runs — classified by
  `classify_log_entry()` against `feed()`'s existing fixed textual
  prefixes rather than a new per-CLI structured parser (see open question 3
  below). All run-scoped events carry `run` (`<role>-r<round>`); task-scoped
  and `gate.finished` events carry `run: null`.
- `crewbench_gate.py`'s `run_gate()` emits `gate.finished` directly (it
  already had `--task-dir`/`--round`, so no interface change was needed —
  see open question 1 below), with the same `steps` array as its own result
  JSON.
- Wrote `docs/app/contract/events.md`: full catalog (line shape, every
  event type's `data` shape and emission point), plus an explicit "not yet
  emitted" section (no `round.verdict`/`issue.*` events yet — nothing reads
  `events.jsonl` back this phase) and a legacy-tasks note (no file at all
  for pre-Phase-0 tasks; readers must treat that as "no events", not an
  error).
- New `tests/test_events.py` (10 tests): every `crewbench_state.py`
  emission point (including the "no event when the value didn't change"
  and "no event for an unrelated key" negative cases), a concurrent-writer
  test (16 threads each driving a real subprocess `append_event` call,
  asserting gapless/monotonic/unique `seq` and no lost or interleaved
  lines), `classify_log_entry()` unit tests for all three classifications
  plus agy's inline-error form, `gate.finished` from a real
  `crewbench_gate.py` subprocess run, and a full real dispatch (fake CLI)
  asserting `run.started` first, `run.finished` last, and gapless `seq`
  across the whole run.
- Manually verified end-to-end (real subprocess `start`/`wait` against the
  `quick_success.py` fake CLI) that `events.jsonl` reads back as valid,
  correctly ordered JSONL before writing the automated test — see the
  session transcript for the raw output.
- Full suite: 205 passed, no regressions.

### Milestone 4 — done (2026-09-19)

Both CLIs were installed and logged in on this machine (`codex-cli
0.154.0`, `GitHub Copilot CLI 1.0.83`), so this was a real investigation
against real `--help` output and real live calls, not a guess — and the
plan's "VERIFY, probably nothing" expectation turned out wrong for both.

- **codex**: `codex exec --help` documents `--json` (JSONL event stream).
  Confirmed live: `thread.started` (session id), `item.completed`/
  `item.started` (`agent_message`/`command_execution`/`error` items),
  `turn.completed` (real token usage), `turn.failed` (structured error).
  Wired a `Stream._codex()` parser, added `--json` to codex's
  `build_command()`, and switched `extract_usage()`'s codex branch from
  the always-null text-scan guess to real `turn.completed` usage. The
  existing `--output-schema`/`-o` file mechanism is unchanged and stays
  the source of truth for the structured result; the stream only adds
  live progress, the session id, and usage.
  - Also fixed a real bug found while verifying `resume_command()` live:
    `codex resume <id>` launches the interactive TUI, not the headless
    exec path — the correct command is `codex exec resume <id>`. The code
    had the wrong one since before this phase.
- **copilot**: `copilot --help` documents both `--output-format json`
  (a large, elaborate live-event schema — session/turn/model/tool
  lifecycle) and `--usage-output-file <file>` (a JSON usage summary
  written after the run). Wired only the latter — small, additive,
  unambiguous shape (`lastCallInputTokens`/`lastCallOutputTokens`; the
  cost-like `totalNanoAiu` field is an internal AI-unit credit metric, not
  USD, so `cost_usd` stays `null`). Deliberately did **not** wire the live
  JSONL event stream into `Stream`/`parse_output` this pass — copilot's
  existing plain-text `-p` mode already produces a correct final result,
  and that event schema is large enough to be its own follow-up rather
  than something to fold into an already-large milestone. Documented as a
  scoped-out follow-up, not a gap nobody noticed.
- Both changes verified two ways: automated tests against real *captured*
  live output (`tests/fixtures/codex_stream.jsonl`, new
  `test_stream_parsers.py`/`test_usage.py`/`test_build_command.py` cases),
  and — separately, manually, outside the test suite — two full real
  dispatches through `crewbench_dispatch.py` itself against the live,
  logged-in CLIs (one codex run hitting `turn.failed` on an
  account-unsupported model name, one succeeding end-to-end with real
  usage; one copilot run succeeding end-to-end with real usage). Findings
  and exact confirmed shapes recorded in `docs/compatibility.md`'s new
  "Structured events & usage investigation" section and in
  `lib/dispatch.md`'s "Usage and timing" section.
- Full suite: 212 passed, no regressions.

### Milestone 5 — done (2026-09-19)

- Wrote `docs/app/contract/README.md`: every file under `.crewbench/`
  (`team.json`, `project.json`, `project.md`, `index.json`,
  `state.json`, `events.jsonl`, `spec.json` (reserved for Phase 1),
  `status.json`, the `<role>-r<round>.*` run-artifact family,
  `gate-r<round>.*`), each with who writes it, who reads it, its schema
  (or "no schema file" where none exists), and whether it's committed —
  plus dedicated sections on the locking discipline (lock order,
  per-task vs. shared locks), the task-id format, `schema_version`
  semantics, timestamp format, and an explicit "what the app must
  preserve" section tying back to `docs/app/CONTEXT.md`'s non-negotiable
  principle 2.
- Added a `## v3.1.0` entry to `CHANGELOG.md` (this repo keeps one entry
  per meaningful release, not per commit — checked `v3.0.0`'s entry and
  recent commit history before choosing a new minor version over folding
  this into an unreleased patch note) covering: `events.jsonl`,
  `schema_version`, real codex/copilot usage (Added); the state/index
  race and the codex resume-command bug (Fixed); task ids and timestamps
  (Changed).
- Ran `python3 scripts/bump_version.py 3.1.0` — bumped `plugin.json`,
  `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` together and
  passed its own `check_manifests.py` sanity check.
- Full suite: 212 passed, no regressions.

## Phase 0: done

All 5 milestones complete. Definition of done, checked against the
original phase prompt:
- Full pytest suite passes (212 tests, this machine's Python 3.9 — CI
  covers 3.9/3.12 on Linux/macOS/Windows, not re-verified across that
  full matrix in this session).
- A real `/crewbench:new-task`-shaped flow was verified piecemeal via
  direct script calls in this session (state/events/dispatch all
  exercised live against real, logged-in CLIs — see milestones 3 and 4's
  notes) rather than one literal `/crewbench:new-task` slash-command
  run inside a host CLI; nothing found suggests that distinction matters,
  but it's worth naming since the prompt asked for the slash command
  specifically.
- `docs/app/contract/README.md` and `events.md` fully describe what's on
  disk.

Ready for Phase 1 (headless TypeScript engine + CLI) whenever you want to
start it — that phase begins the same way, with its own plan file for
review before implementation.
