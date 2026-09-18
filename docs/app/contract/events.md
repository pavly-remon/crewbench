# events.jsonl — event catalog

`.crewbench/tasks/<task-id>/events.jsonl` is an append-only, line-delimited
JSON log of everything that happened to one task. It exists so a long-running
daemon (Phase 2+) can tail a task's activity without polling `state.json` and
`status.json` and diffing them itself, and so a restarted daemon can replay
history from a `seq` offset instead of losing anything.

It is written by three plugin scripts today (`crewbench_state.py`,
`crewbench_dispatch.py`, `crewbench_gate.py`), all going through one shared
writer, `crewbench_fs.append_event()`. Nothing else appends to it directly.

## Line shape

Every line is one JSON object:

```json
{ "v": 1, "ts": "2026-09-18T14:03:22Z", "seq": 7, "type": "run.started",
  "task_id": "20260918-1400-fix-login-a1b2", "run": "developer-r1",
  "data": { "role": "developer", "cli": "agy", "model": "gemini-3.8-flash", "effort": "medium" } }
```

- `v` — the events **format** version (currently `1`), separate from
  `schema_version` on `state.json`/`index.json`/`status.json`/the dispatch
  envelope. This is the shape of the event line itself, not the contract
  version of the task.
- `ts` — UTC ISO-8601 with an explicit `Z` offset (`crewbench_fs.now_iso()`).
  Every event line uses this format from the start — there is no legacy
  events.jsonl format to be compatible with, unlike `state.json`'s
  naive-local timestamps from before this phase.
- `seq` — a per-task, monotonically increasing, gapless integer starting at
  1. Computed by reading the last line's `seq` under the same lock used for
  the append itself (`crewbench_fs._last_seq()` + the append, both inside
  one `locked_read_modify_write` critical section), so concurrent writers
  (e.g. a tester run and a reviewer run finishing at the same moment) can
  never produce a duplicate `seq` or interleave a partial line. This is an
  `O(events-so-far)` read on every append (it re-scans the file to find the
  last line) — fine at the hundreds-of-events-per-task scale a single task
  produces, but worth knowing if a future phase wants a much larger event
  volume per task.
- `type` — one of the event types below.
- `task_id` — the task directory's name (`Path(task_dir).name`), redundant
  with the file's own path but useful once a daemon merges many tasks'
  streams into one view.
- `run` — the run name (`<role>-r<round>`, e.g. `developer-r1`) for
  run-scoped events, or `null` for task-scoped events (`task.*`) and
  `gate.finished` (a gate step isn't a "run").
- `data` — the event-specific payload, documented per type below.

## Event types

### `task.created`
Emitted once, by `crewbench_state.py new`.
`data`: `{ "command": "new-task"|"test"|"review"|"design", "title": string, "jira_key": string|null }`

### `task.phase_changed`
Emitted by `crewbench_state.py set --key phase` whenever the new value
differs from the old one (setting the same phase again emits nothing).
`data`: `{ "from": string|null, "to": string }` — `from` is `null` only if
`phase` was somehow unset before (shouldn't happen for a task created after
this phase, since `new` always sets it to `"scoping"`).

### `task.round_started`
Emitted by `crewbench_state.py set --key round`, same "only on an actual
change" rule as `phase_changed`.
`data`: `{ "round": integer }`

### `task.note_added`
Emitted by `crewbench_state.py append --key notes`.
`data`: `{ "note": <value appended> }` — normally a string, but whatever
JSON value was appended is passed through as-is.

### `run.started`
Emitted by `crewbench_dispatch.py` right before it spawns a role's CLI
process (foreground or via `start`).
`data`: `{ "role": string, "cli": string, "model": string, "effort": string }`

### `run.finished`
Emitted by `crewbench_dispatch.py`'s `finish()`, for every exit path
(success, validation failure, timeout, CLI-not-installed, argv-too-large,
etc.) — always the last event for a given `run`.
`data`: `{ "ok": bool, "exit_code": int|null, "duration_s": number|null,
"error": string|null, "usage": {...}|null }` — `usage` is the same object
as the envelope's `usage` field (see `lib/dispatch.md`'s "Usage and
timing").

### `run.message` / `run.tool_call` / `run.tool_error`
Emitted by `crewbench_dispatch.py` for every readable line `Stream.feed()`
produces while a role's process is running — the same content that goes
into the `.log` file, structured instead of prose. Classification
(`crewbench_dispatch.classify_log_entry()`) matches on the fixed textual
prefixes `Stream.feed()` already normalizes every CLI's output into
(`"tool: ..."`, `"  error: ..."`, plain text), rather than re-parsing each
CLI's raw stream a second time — cheap, and correct for all four CLIs at
once since `feed()` is the single place their differences are already
absorbed:
- a line starting with `"tool: "` and containing `" -> "` (agy's inline
  tool-error form) or starting with `"  error:"` (claude's separate
  tool-result-error line) → `run.tool_error`.
- a line starting with `"tool: "` with no error marker → `run.tool_call`.
- everything else (assistant text, "session started ...", "finished: ...")
  → `run.message`.

`data`: `{ "text": string }` in all three cases — the exact string that
also went into the `.log` file. A future phase that wants structured
fields (tool name, arguments, session id) per event, instead of the same
free text as the log, would need to change `Stream.feed()`'s return value
itself, not just this classifier — see `docs/app/phase-0-plan.md`'s open
question 3.

### `gate.finished`
Emitted by `crewbench_gate.py` itself (it already takes `--task-dir` and
`--round`), right after it writes `gate-r<n>.result.json`. `run` is always
`null` — a gate run isn't a role run.
`data`: `{ "round": integer, "ok": bool, "steps": [...] }` — `steps` is the
same array as the gate's own result JSON (`name`, `command`, `exit_code`,
`duration_s`, `timed_out`, `output_tail` per step).

### `git.warning`
Emitted by `crewbench_dispatch.py`, once per warning string
`git_changes()` produces after a role's run (see `lib/dispatch.md` §4's
"Commits" section for the full list of conditions that produce a
warning — moved HEAD, reverted uncommitted files, a read-only role that
wrote something, etc.).
`data`: `{ "warning": string }` — the exact warning text, same as what
lands in the envelope's `warnings` array.

## Not yet emitted

`lib/dispatch.md`'s reporting step (§7, usage summary) and the fix-loop's
combined-issue-list bookkeeping are still purely `state.json`-side — there
is no `round.verdict` or `issue.*` event type yet. Nothing in Phase 0 reads
`events.jsonl` back (the plugin skills still read `state.json` and
`status.json` directly); it exists purely as a write-side addition this
phase, ready for a future daemon to consume.

## Legacy tasks

A task created before this phase has no `events.jsonl` at all — readers
must treat a missing file as "no events recorded", not an error. Nothing
backfills history for a task that already existed.
