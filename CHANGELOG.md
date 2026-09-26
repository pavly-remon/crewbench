# Changelog

## v3.2.0 (proposed — not yet tagged or published)

The crewbench **app**: an installable local tool (daemon + web UI + CLI)
that runs the same workflow the plugin does, standalone, alongside it —
the plugin keeps working unchanged throughout. Covers everything since
v3.1.0 (Phases 1–4 of the app build, `docs/app/CONTEXT.md`), not just
this release's own diff — the app didn't exist in any previous release.
Real, disclosed gaps this release doesn't close: `npm publish` has never
been run for real (the package name `crewbench` is reserved by nothing
but being unclaimed — see Open question 5 in `docs/app/phase-4-plan.md`),
and `crewbench service install`'s real launchd/systemd/Task Scheduler
registration has never been exercised end-to-end on a real machine (built
and tested with every actual OS call mocked, by deliberate, disclosed
choice — see that plan's milestone 4 log).

### Added

- **`crewbench` CLI** (`npm i -g crewbench`, or `npx crewbench`): `run`
  (headless, one task, terminal-driven — the same workflow `/crewbench:new-task`
  runs, without an LLM host CLI in the loop), `resume`, `status`, `doctor`,
  `team`, `profile`, `ui`, `service install|uninstall`. Bundled as a
  single published package (`esbuild`) — the four internal `@crewbench/*`
  packages (contract, adapters, engine, daemon) stay private, inlined at
  build time, never separately published.
- **`crewbench ui`**: starts a local daemon (loopback-only, a fresh
  bearer token per run, never persisted to disk) and opens a web UI to:
  add a project (a real server-side folder browser, not manual path
  entry), create and scope a task in a live chat with the lead, pick the
  lineup (per-role CLI/model/effort/permissions, with a real model
  dropdown for any CLI that can actually enumerate its own models —
  today, only `agy`), watch a fix round run live (per-role status, real
  diffs, issues/failures tables), resolve approvals from a global inbox
  (desktop notifications, opt-in), and cancel/resume/retry a run — all
  daemon-hosted, no separate CLI subprocess per task.
  - A first-run onboarding wizard (CLI detection + login instructions,
    add your first project, offer to install the plugin into each
    detected CLI, confirmed before running).
  - An embedded terminal ("Open session" on a resumable task) backed by
    a true optional dependency (`node-pty`) — degrades to a "copy resume
    command" button on any platform where it isn't available, never a
    broken button.
  - A global settings page (port, per-CLI concurrency limits, a
    machine-wide default lineup, notification/theme defaults) and a
    non-blocking "a newer version is available" banner (checked against
    the npm registry at most once a day, never auto-updating).
  - `crewbench service install|uninstall`: generates a real launchd
    plist / systemd user unit / Windows Task Scheduler entry to run the
    daemon at login.
- **`/crewbench:open [task-id]`**: opens a task (or the UI's front page)
  in the browser if a daemon is already running on this machine —
  read-only, no token involved (Phase 2's "never persisted" principle
  applies here too: it can only open a page, never authenticate one on
  its own). `/crewbench:status` now also mentions when a live daemon is
  reachable.
- The full `.crewbench/` on-disk contract (task state, events, results)
  is now shared, unmodified, between the plugin and the app — either one
  can create, drive, or resume a task; the other picks it up exactly
  where it left off.

### Fixed (real, pre-existing bugs found while building the app, disclosed at the time)

- `crewbench resume`'s own CLI command silently did nothing for a
  `stopped`/`failed` task (matching only the plugin's original, narrower
  meaning of "resumable") — the daemon-hosted app had already established
  a real, wider "resumable" set for those two phases; the CLI now matches
  it, so a task's own real "copy resume command" button (and the
  embedded terminal built on top of it) actually works.
- `reconcileDeadRuns()`'s pid-based dead-process detection was silently
  non-functional since it shipped (Phase 1) — nothing ever wrote the
  `pid` field it read.
- A task's phase could get silently stuck reporting a stale, mid-round
  value forever after a real commit approval resolved, or after a user
  cancelled it — both are pure runtime signals with no corresponding
  `runs/*.result.json` file for the existing file-replay logic to ever
  notice.

See `docs/app/phase-1-plan.md` through `docs/app/phase-4-plan.md`'s own
milestone logs for the full, real-time account of every design decision,
deviation, and bug found along the way — this entry summarizes; those
logs are the record.

## v3.1.0

Phase 0 of the crewbench-app build (see `docs/app/CONTEXT.md` and
`docs/app/phase-0-plan.md`): hardens the `.crewbench/` on-disk format into
a safe, versioned contract a future standalone app can rely on alongside
the plugin, with no change to plugin workflow behavior. Full contract
reference: `docs/app/contract/README.md`.

### Added

- **`events.jsonl`**: an append-only, per-task structured event log
  (`task.created`, `task.phase_changed`, `task.round_started`,
  `task.note_added`, `run.started`, `run.finished`, `run.message`,
  `run.tool_call`, `run.tool_error`, `gate.finished`, `git.warning`) —
  write-side only this release; nothing reads it back yet. Full catalog:
  `docs/app/contract/events.md`.
- **`schema_version`** on `state.json`, `index.json` entries,
  `status.json` entries, and the dispatch result envelope (current: 1;
  missing means legacy version 0).
- **Real codex usage and live progress**: `codex exec --json`'s event
  stream now feeds real per-run token usage and live tool-call/message
  progress, instead of an always-null best-effort text scan.
- **Real copilot usage**: `--usage-output-file` now feeds real per-call
  token usage, instead of an always-null best-effort text scan.

### Fixed

- **Race-free `state.json`/`index.json` writes.** Concurrent updates to
  the same task (most commonly a tester run and a reviewer run finishing
  at the same moment) could previously lose one of the two updates; both
  files now go through one locked read-modify-write.
- **`codex exec resume <id>` was never reachable.** The envelope's
  `resume_command` for codex was `codex resume <id>`, which opens the
  interactive TUI, not the headless equivalent — it's now
  `codex exec resume <id>`.

### Changed

- Task ids gain a 4-hex-char suffix
  (`YYYYMMDD-HHMM-<slug>-<hex>`) to stop two same-minute, similarly-worded
  tasks from colliding. Older ids without the suffix keep working
  everywhere.
- Every structured timestamp (`created_at`, `updated_at`, `started_at`,
  `finished_at`) is now UTC ISO-8601 with an explicit `Z` offset instead
  of naive local time. Readers still accept the old naive format.

## v3.0.0

A large "make it practical for daily use" release. Every crewbench-owned
file changed; if you're upgrading from 2.x, read the README's "Upgrading
from 2.x" section before your next task.

### Breaking / layout changes

- Run artifacts moved from `.crewbench/runs/` to
  `.crewbench/tasks/<task-id>/runs/<role>-r<round>.*` — every task now has
  its own folder and a `state.json` (see "Task identity" below).
  `.crewbench/team.json` keeps working unchanged.
- `new-task` now isolates each task in a git worktree
  (`.crewbench/wt/<task-id>`) by default. Set `workspace.mode: in-place`
  in `.crewbench/team.json` to keep the pre-3.0 behavior of working
  directly in your checkout.

### Added

- **Task identity, state, and resumability**: every task gets an id, a
  `state.json`, `/crewbench:status` to inspect it, and `/crewbench:resume`
  to pick an interrupted one back up without re-asking the lineup.
- **Git worktree isolation** for `new-task`, with a pre-flight (dirty-tree
  check, environment setup, `.env*` copy prompt) and a commit step that
  asks how to bring the work back (merge, cherry-pick, leave the branch).
- **Cross-CLI interoperability**: any host CLI (Claude Code, Codex,
  Copilot CLI, Antigravity `agy`) can delegate any role to any of the
  four, via a detached start/wait/cancel dispatch protocol that doesn't
  depend on your shell tool's own timeout or backgrounding behavior.
  `/crewbench:doctor` preflights a CLI's install/network/auth before it's
  dispatched to.
- **Diff-aware review loop**: the reviewer always gets a real diff against
  the task's base commit; later rounds also get the delta since the
  previous round and must say whether each prior issue is resolved. A
  severity threshold (`loop.fix_threshold`) and oscillation detection stop
  the loop from spinning on the same stuck issue.
- **Project profile** (`.crewbench/project.json`/`project.md`,
  `/crewbench:profile`): detects package manager, lint/typecheck/test/
  build commands, languages and frameworks once, confirmed by you, then
  shared with every role hand-off instead of each role rediscovering it.
- **Deterministic gate** (`bin/crewbench_gate.py`): runs your project's
  own lint/typecheck/test commands before the LLM tester; a failing step
  goes straight back to the developer instead of spending a tester/
  reviewer round on it.
- **Less ceremony**: `confirm_lineup` skips re-asking about a saved
  lineup; `--yes`/`--design`/`--in-place`/`--rounds N`/`--dev`/`--review`
  flags shortcut questions you already know the answer to. Commit and
  push confirmation are never skippable.
- **Usage and timing report**: every run records whatever timing/token/
  cost data its CLI exposes; the final report and `/crewbench:status` end
  with a one-line-per-role summary and a total.
- `scripts/bump_version.py` for keeping all three plugin manifests' 
  version in sync, alongside the existing `scripts/check_manifests.py` CI
  check.
- Model name freshness and a Copilot-`safe`-tester warning in
  `/crewbench:team`.

### Fixed

- Native subagents (Claude Code / Copilot) now always run on the
  explicitly resolved model — previously they could silently run on
  whatever the agent frontmatter said if it drifted from the tier
  defaults (it had: `developer.md` was `haiku`, not the documented tier).
- Large hand-offs (a full diff, several prior rounds) no longer crash agy
  or Copilot with `E2BIG` — the full prompt is always written to a file;
  CLIs without a stdin-prompt mode get a short pointer to it instead of
  the whole thing on argv.
- The git safety snapshot now catches `git stash`, `git checkout -- .`,
  `git reset --hard` and similar silent-revert operations — previously it
  only compared HEAD/branch/remote refs, missing exactly the case that
  matters most (a role wiping an earlier round's uncommitted work). A
  harmless `git fetch` no longer triggers a "history changed" warning.
- Timeouts kill the whole process group, not just the direct child
  (previously node/helper processes the CLI spawned could survive), and
  a single deadline is now enforced across an entire run including agy's
  denial-resume retries (previously each retry got a fresh full timeout).
- Result-schema validation is now a real recursive JSON Schema check
  (`type`, `enum`, `required`, nested `properties`/`items`) instead of
  only checking top-level fields — malformed `issues[]`/`failures[]`
  entries are now caught instead of breaking the Team Lead's merge later.
- The dispatch script no longer crashes at import time on Windows
  (`fcntl` is now imported lazily, with an `msvcrt` fallback).
- Headless `codex` dispatch no longer fails outright with a 400: OpenAI's
  structured-outputs strict mode (which `codex exec --output-schema`
  uses) rejects any schema with an optional top-level property, which
  `code-reviewer`'s `previous_issues` and `tester`'s `screenshots` both
  are by design. codex now gets its own transformed copy of the schema
  (every property required, optional ones made nullable instead); the
  resulting explicit `null` it sends back for an unused optional field is
  treated the same as an omitted key for validation and merging.
- `doctor`'s config-dir check no longer reports a CLI as unusable just
  because its config directory (e.g. `~/.claude`) hasn't been created
  yet on this machine — found on a fresh CI run — it now also accepts a
  directory that doesn't exist yet but has a writable existing ancestor
  (config dirs are typically created lazily on first login).
- `CREWBENCH_CLI_OVERRIDE_<CLI>` (test-only, injects a fake CLI script)
  no longer fails to launch on Windows — found running this repo's own
  test suite for real on Windows CI — a bare `.py` path isn't directly
  executable there without `shell=True`; it's now launched through the
  current Python interpreter on Windows specifically. Never affects a
  real installed CLI in production.
- Every file the dispatch scripts read or write (role briefs, schemas,
  prompts, logs, `state.json`, `status.json`, project files) now opens
  with an explicit `encoding="utf-8"` instead of the platform default —
  the role briefs and this repo's own Markdown are full of em dashes and
  section marks that a non-UTF-8 default locale (the common case on
  Windows) can't decode, which silently crashed the whole dispatch
  process before it could print anything.
- Writing a role's prompt to a child's stdin no longer crashes the whole
  run if the child exits (or just closes stdin) before reading it all —
  confirmed live on Windows, where this raises `BrokenPipeError`
  immediately rather than tolerating it.
- `crewbench_env.py`'s `check-model`/`list_models()` (and, indirectly,
  `/crewbench:team`'s model-freshness check) now also goes through the
  same Windows `.py`-launch fix as the main dispatch path — it was
  missed in the first pass at that fix.
- `crewbench_gate.py`'s command splitting picks the right `shlex` mode
  now instead of just one of the two available trade-offs — confirmed
  live on Windows: `posix=False` keeps a quoted command's literal quote
  characters as part of one argument (so `python -c "import sys;
  sys.exit(1)"` ran as a harmless string-literal statement instead of
  the intended code, silently "succeeding"), but `posix=True` mangles a
  Windows backslash path by treating each backslash as an escape
  character. Now always tokenizes with `posix=False`, then manually
  strips one matching pair of quote characters from each token.
