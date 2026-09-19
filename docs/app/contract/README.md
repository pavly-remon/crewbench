# The `.crewbench/` contract

This is the on-disk format shared by the plugin (this repo's `bin/*.py`
scripts, driven by the LLM Team Lead per `lib/dispatch.md`) and, from
Phase 1 onward, the standalone app (`app/packages/*`, see
`docs/app/CONTEXT.md`). Both read and write these files directly — neither
side owns the other; the files on disk are the single source of truth.
This document is what Phase 1's TypeScript contract package is written
against, so every field, writer and reader is named explicitly, not left
implicit.

Everything below lives under a project's `.crewbench/` directory (created
on demand, next to the project's `.git`).

```
.crewbench/
  team.json            user-owned, committable
  project.json          committable, written after user confirmation
  project.md            committable, user/edit-only free-form prose
  index.json            auto-maintained, not committed
  tasks/<task-id>/
    state.json
    events.jsonl
    spec.json            (Phase 1+, task-spec — not written by the plugin today)
    .state.json.lock      (lock file, not data)
    .events.lock          (lock file, not data)
    runs/
      status.json
      <role>-r<round>.md            hand-off
      <role>-r<round>.prompt.md     full assembled prompt
      <role>-r<round>.log           human-readable live log
      <role>-r<round>.result.json  dispatch envelope
      <role>-r<round>.raw.txt      raw stdout+stderr
      gate-r<round>.log
      gate-r<round>.result.json
      .status.lock         (lock file, not data)
  wt/<task-id>/          git worktree (workspace.mode: worktree only)
```

`.crewbench/tasks/` and `.crewbench/wt/` are added to `.git/info/exclude`
(never committed); `team.json`, `project.json`, `project.md` and
`index.json` are meant to be committed (see each file's section).

## `team.json`

**Written by:** the user, or `/crewbench:team set ...`. Never
auto-generated.
**Read by:** every skill, at the start of lineup resolution (`lib/dispatch.md`
§1); the dispatch script does not read it directly — the Team Lead resolves
the lineup and passes concrete `--cli`/`--model`/`--effort`/permissions per
role.
**Shape:** no JSON Schema file (loosely structured, see `config/defaults.json`
for the shape it overrides): `roles.<role>.{cli,model,effort,permissions}`,
`tiers.<cli>.{cheap,strong}`, `loop.{max_rounds,fix_threshold}`,
`confirm_lineup`, `workspace.{mode,setup,copy}`.
**Committable:** yes — this is the team's shared configuration.

## `project.json`

**Written by:** `bin/crewbench_profile.py detect`, but only saved to disk
after the user confirms or corrects it (`lib/dispatch.md` §0's "Project
profile"). `/crewbench:profile refresh` re-runs detection the same way.
**Read by:** every role hand-off (a summary is included in each one);
`bin/crewbench_gate.py` reads `commands` directly to decide which gate
steps to run.
**Schema:** `schemas/project.json`. `additionalProperties: true` — this
file already goes through a human-confirmation step, so it's loose by
design, unlike the strict per-role result schemas.
**Committable:** yes.

## `project.md`

**Written by:** the user, or `/crewbench:profile edit`. crewbench never
invents conventions and writes them here on its own.
**Read by:** every role hand-off (its prose is summarized alongside
`project.json`'s structured fields), if present.
**Shape:** free-form Markdown prose (folder structure, state management,
styling approach, testing conventions).
**Committable:** yes.

## `index.json`

**Written by:** `crewbench_state.py`'s `mutate_state()` — every `new`/
`set`/`append` call updates this file's entry for that task, under the
same lock as the `state.json` write (see "Locking", below).
**Read by:** `crewbench_state.py list` (`/crewbench:status` with no
argument); a future daemon's project-level task listing.
**Shape:** `{ "<task-id>": { schema_version, id, command, title, phase,
round, updated_at } }` — one entry per task, a denormalized summary of
that task's `state.json` for cheap listing without opening every task
folder.
**Not committed** (excluded via `.git/info/exclude`, despite living at the
`.crewbench/` root rather than under `tasks/`) — task activity is
per-checkout, ephemeral state, not shared config.

## `tasks/<task-id>/state.json`

**Written by:** `crewbench_state.py new`/`set`/`append`, exclusively —
nothing else writes this file directly. The LLM Team Lead calls the
script; it never hand-edits JSON.
**Read by:** `crewbench_state.py get` (`/crewbench:status`,
`/crewbench:resume`); every hand-off template (round history, lineup);
the app's engine (Phase 1+), which must produce byte-for-byte the same
shape so plugin- and app-created tasks stay interchangeable.
**Schema:** `schemas/task-state.json`.
**Key fields:** `id` (see "Task ids", below), `schema_version` (missing =
legacy version 0; current = 1), `command`
(`new-task`/`test`/`review`/`design`), `phase` (the enum in
`schemas/task-state.json`), `round`, `lineup` (resolved
cli/model/effort/permissions per role), `base_commit`/`branch`/`worktree`
(null for in-place tasks), `jira_key`, `doctor` (cached per-CLI doctor
results for the task's session), `acceptance_criteria`, `rounds` (one
entry per fix-loop round: gate result, verdicts, open issue ids),
`usage` (keyed by role: `runs`, `duration_s`, `tokens`, `cost_usd`,
`cli`, `model` — see `lib/dispatch.md` §4's "Usage and timing"), `notes`.
**Not committed.**

## `tasks/<task-id>/events.jsonl`

**Written by:** `crewbench_fs.append_event()`, called from
`crewbench_state.py` (task.\* events), `crewbench_dispatch.py` (run.\*,
git.warning), and `crewbench_gate.py` (gate.finished). Append-only —
nothing rewrites or truncates a line once written.
**Read by:** nothing in the plugin today (write-side only, added this
phase for a future daemon to tail). A future daemon reads it
incrementally by byte/seq offset, per `docs/app/CONTEXT.md`'s Phase 2 API
sketch.
**Full catalog:** `docs/app/contract/events.md`.
**Not committed.** Missing entirely for any task created before this
phase — readers must treat that as "no events", not an error.

## `tasks/<task-id>/spec.json`

**Not written by the plugin.** Reserved for Phase 1's TypeScript engine
(the output of the scoping step — `title`, `description`,
`acceptance_criteria[]`, `affected_areas[]`, `out_of_scope[]`,
`needs_design`, `design_notes?`, `jira_key?`, `constraints[]`, per
`docs/app/CONTEXT.md`'s Phase 1 prompt). Listed here so Phase 1 doesn't
have to guess the path convention; `state.json` will point to it once it
exists.

## `tasks/<task-id>/runs/status.json`

**Written by:** `crewbench_dispatch.py`'s `update_status()` — every
`start`/foreground dispatch/`cancel` call merges fields into this file
under that run's name, holding one lock across the whole
read-modify-write.
**Read by:** `crewbench_dispatch.py wait`/`cancel` (reads its own writes);
`/crewbench:status` and `/crewbench:resume` (pid liveness checks, log
paths, resume commands) read it directly, not through the script.
**Shape:** `{ "<role>-r<round>": { schema_version, state
("starting"/"running"/"done"/"failed"), pid, launcher_pid, role, cli,
model, effort, started_at, finished_at, log_file, session_id,
resume_command, error } }` — no JSON Schema file (internal to the
dispatch script; the plugin's other consumers read it structurally, not
against a schema).
**Not committed.**

## `tasks/<task-id>/runs/<role>-r<round>.*`

One family of files per run, all sharing the `<role>-r<round>` stem
(`developer-r1`, `tester-r2`, ...):

- **`.md`** — the hand-off text, written by the Team Lead before dispatch.
- **`.prompt.md`** — the full assembled prompt (role brief + limits +
  hand-off + result schema), written by `crewbench_dispatch.py`. Claude
  and codex read this from stdin; agy and copilot get a short pointer to
  its path instead (avoids `E2BIG` on large hand-offs).
- **`.log`** — human-readable live log (`[HH:MM:SS] <line>` per entry),
  written incrementally by `crewbench_dispatch.py` as the child CLI's
  output streams in. Local-time prefix, deliberately not UTC — this is
  for a human tailing the file, not a structured field (contrast with
  `events.jsonl`, which is UTC).
- **`.result.json`** — the dispatch envelope (see `lib/dispatch.md` §4 for
  the full shape: `ok`, `exit_code`, `duration_s`, `result`, `usage`,
  `permission_denials`, `error`, `warnings`, `notes`, `session_id`,
  `resume_command`, plus `schema_version`). Written once, at the end of
  the run, by `crewbench_dispatch.py`'s `finish()`.
- **`.raw.txt`** — raw stdout+stderr, for debugging a parser mismatch.

**Read by:** the Team Lead (merges `result` into the fix list, reports
`usage`/`warnings`/`notes` to the user); `/crewbench:status` (reads
`.result.json` for `resume_command`); the app's runner (Phase 1+), which
must write this same file family so the plugin's `/crewbench:status` can
read an app-created task's runs.
**Not committed.**

## `tasks/<task-id>/runs/gate-r<round>.*`

**Written by:** `bin/crewbench_gate.py`'s `run_gate()`.
**Read by:** the Team Lead (folds the gate result into `state.json.rounds`
by hand — the gate script itself only writes the run's own files plus a
`gate.finished` event, it does not touch `state.json`).
**Shape:** `{ "ok": bool, "steps": [ { name, command, exit_code,
duration_s, timed_out, output_tail } ] }`.
**Not committed.**

## Locking

Every read-modify-write against a shared file goes through
`bin/crewbench_fs.py`'s `locked_read_modify_write()` (POSIX `fcntl.flock`,
Windows `msvcrt.locking`), so two concurrent writers — most commonly a
tester run and a reviewer run finishing at the same moment — never lose
an update or interleave a partial write:

- **`state.json` + `index.json`**: `crewbench_state.py`'s `mutate_state()`
  takes the per-task `.state.json.lock` first, then — still inside it —
  the shared `.index.json.lock` at the `.crewbench` root (shared because
  `index.json` itself is shared across every task under that root). Lock
  order is always state-then-index, so two different tasks' writes can
  never deadlock on each other.
- **`status.json`**: `update_status()` takes `runs/.status.lock` across
  the whole read-modify-write.
- **`events.jsonl`**: `append_event()` takes `.events.lock` across
  computing the next `seq` (by reading the file's last line) and
  appending the new one.

A reader (e.g. `/crewbench:status`, or a future daemon's file watcher)
does not need to take any lock — every write is atomic (temp file +
rename for the JSON files; a single `write()` + `\n` for one
`events.jsonl` line under its own lock), so a reader never sees a
half-written file, only a possibly-stale one.

## Task ids

`YYYYMMDD-HHMM-<up-to-5-word-kebab-slug>-<4 hex>` (e.g.
`20260918-1400-fix-login-redirect-a1b2`). The hex suffix (added this
phase) guards against two tasks started in the same minute with a
similar description colliding and silently overwriting each other's
directory. Older ids without the suffix (from before this phase) keep
working everywhere — nothing requires the suffix to be present, readers
just don't assume every id has one.

## `schema_version`

`state.json`, `index.json` entries, `status.json` entries, and the
dispatch result envelope each carry a `schema_version` field (current: 1).
**Missing means legacy version 0** — every reader must handle that case
rather than assuming the field is always present; nothing in this phase
migrates old files to add it retroactively. This is a different version
number from `events.jsonl`'s own `v` field (the *event line's* format
version — see `docs/app/contract/events.md`) — the two evolve
independently, since a new event type doesn't change `state.json`'s shape
and vice versa.

## Timestamps

Every timestamp in a **structured field** (`created_at`, `updated_at`,
`started_at`, `finished_at`, every `events.jsonl` `ts`) is UTC ISO-8601
with an explicit `Z` offset (`crewbench_fs.now_iso()`), e.g.
`2026-09-18T14:03:22Z`. A reader must still accept the old naive-local
format (no offset) from before this phase —
`crewbench_fs.parse_legacy_or_utc()` handles both, treating a naive value
as local time. **Human-facing log lines** (`.log` files' `[HH:MM:SS]`
prefix) intentionally keep a short local-time format — they're for a
person tailing the file, not a machine comparing timestamps.

## What the app must preserve

Anything in `app/packages/*` (Phase 1+) that writes into `.crewbench/`
must produce files a plugin-side reader (`crewbench_state.py`,
`/crewbench:status`, `/crewbench:resume`) can read without modification,
and vice versa — this is `docs/app/CONTEXT.md`'s non-negotiable principle
2. Concretely, that means: the same `state.json`/`index.json`/
`status.json` shapes (including `schema_version` and the locking
discipline above), the same task-id format, the same run-artifact file
family and naming (`<role>-r<round>.*`), and emitting `events.jsonl` in
the same shape if the app wants plugin-created tasks' events and its own
to be indistinguishable to a shared UI.
