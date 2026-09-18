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

1. **Event emission for gate results.** `crewbench_gate.py` today just prints
   a result the Team Lead folds into `state.json.rounds` by hand — should
   `gate.finished` be emitted by the gate script itself (needs a task-dir
   argument it doesn't currently take), or by `crewbench_state.py` when the
   Team Lead's `set --key rounds...` includes a gate result? Leaning toward
   the gate script taking an optional `--task-dir`/`--round` and emitting
   directly, so the event fires even from a bare CLI run — but this is a
   real interface change worth confirming before writing it.
2. **Do old-format task ids (no hex suffix) need a migration, or just
   read-compatibility?** The phase prompt says "old ids must keep working
   everywhere" — read this plan as read-compatibility only, no rewrite of
   existing task directories. Confirm that's the intent.
3. **`run.tool_call`/`run.tool_error` granularity.** The existing `Stream`
   parser's job today is producing readable `.log` lines, not a typed event
   per tool call. Emitting a structured event per tool call/message means
   walking each CLI's existing text/stream-json parsing branch in `Stream`
   and adding a return value alongside the log line, for all four CLIs — this
   is the largest single chunk of new code in milestone 3. Flagging the size
   now so it isn't a surprise mid-milestone.

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
