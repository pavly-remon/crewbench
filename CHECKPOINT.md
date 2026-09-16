# v3-daily-use implementation checkpoint

Working from `/Users/pavly/Downloads/crewbench-v3-implementation-prompt.md` on branch
`v3-daily-use`. One commit per phase. This file tracks progress so work can resume
after a context reset — update the **Status** table after every commit.

CLIs installed on this machine (verified via `--help`): `claude` 2.1.272, `agy` 1.2.2,
`codex` 0.154.0 (codex-cli), `copilot` 1.0.83. No `pytest` installed yet (Phase 2 will
need it for local test runs; CI installs it).

## Key VERIFY findings from `--help` (before writing code)

- **claude**: `-p/--print` reads the prompt from stdin when no positional prompt is
  given ("useful for pipes"). `--permission-mode` choices: `acceptEdits, auto,
  bypassPermissions, manual, dontAsk, plan`. Matches dispatch.md's `auto`/`plan`/
  `bypassPermissions` usage.
- **codex**: `codex exec [PROMPT]` reads stdin when PROMPT is omitted or `-`. Matches
  current code.
- **agy**: `-p`/`--print`/`--prompt` all take the prompt as their **value** — no
  documented stdin mode. `agy models` lists available models (no help subcommand
  `agy help print`). Confirms 1.2's plan: agy needs the "read instructions from this
  file" short-prompt approach, not stdin.
- **copilot**: `-p, --prompt <text>` also takes the prompt as a value, no documented
  stdin mode. Same fix as agy. `copilot` has no model-listing subcommand found in
  `--help`/`help commands` — Phase 9 model-freshness check is claude/agy only;
  codex/copilot flagged VERIFY (no discovered list-models command).
- **codex sandbox**: confirmed flags `read-only`, `workspace-write`,
  `danger-full-access` — matches existing code.

## Status

| Phase | Status | Commit |
|---|---|---|
| 0 Read repo + plan | done | (this file) |
| 1 Correctness bugs | done | fix: Phase 1 correctness bugs |
| 2 Test harness + CI | done | test: Phase 2 test harness and CI |
| 3 Diff-aware review loop | done | feat: Phase 3 diff-aware review loop |
| 4 Task identity/state/status/resume | done | feat: Phase 4 task identity, state, status and resume |
| 5 Git worktree isolation | done | feat: Phase 5 git worktree isolation |
| 6 Cross-CLI interoperability | done | feat: Phase 6 cross-CLI interoperability |
| 7 Project profile + gate | done | feat: Phase 7 project profile and deterministic gate |
| 8 Less ceremony | done | feat: Phase 8 less ceremony for daily use |
| 9 Usage/timing report | done | feat: Phase 9 usage and timing report |
| 10 Maintenance/structure | pending | |
| 11 Optional integrations | pending | |
| 12 Docs and release | pending | |

## Notes / deviations / VERIFY items (running list)

### Phase 1

- 1.1: developer.md/tester.md/code-reviewer.md frontmatter set to
  sonnet/opus/opus (ui-ux already sonnet). dispatch.md §3 now says "always
  pass model explicitly" for Claude native subagents. Copilot native-agent
  rule rewritten per the prompt's fallback wording; **VERIFY**: found no
  Copilot flag/doc for a per-call model override on a custom agent in
  `copilot --help` / `copilot help commands` (1.0.83), so that branch is
  effectively unreachable today — Copilot custom agents always go headless
  unless the resolved model/effort equals the copilot tier default exactly.
- 1.2: prompt now always written to `<handoff>.prompt.md`. Claude/codex keep
  reading the full prompt from stdin (confirmed via `--help`: claude's
  `-p/--print` is documented "useful for pipes" with no positional prompt
  supplied, i.e. stdin; codex's `[PROMPT]` explicitly reads stdin when
  omitted). agy and Copilot's `-p` only documented to take the prompt as an
  argv value (**VERIFY**: no stdin mode found in either's `--help`) — both
  now get a short pointer prompt referencing the file's absolute path.
  Added `check_argv_size()` (100 KB/argv-element guard) called before every
  exec attempt, including agy's denial-resume follow-up (which now also
  goes through a `<handoff>.resumeN.prompt.md` file + pointer).
- 1.3: `git_state()`/`git_changes()` rewritten: added `stash` list and a
  path->sha256 `dirty` snapshot (via `git status --porcelain=v1 -z`,
  handling renames/copies and deletions). New warnings: stash changed,
  dirty-before paths reverted/deleted, code-reviewer's working tree changed
  at all, tester touched a non-test file (heuristic in module-level
  `TEST_PATH_PATTERNS`, ready for Phase 6 to extend). Remote-ref changes now
  split into a `notes` entry ("likely git fetch") when local HEAD didn't
  move, an actual push warning when the upstream ref can be confirmed to
  match the new local HEAD, and a conservative "changed alongside local
  history" note otherwise (deliberately not claiming a push it can't prove).
  Envelope gained a `notes` field alongside `warnings`.
- 1.4: children now launch in their own process group/session
  (`start_new_session=True` POSIX / `CREATE_NEW_PROCESS_GROUP` Windows) and
  are killed as a group (`os.killpg` SIGTERM -> 10s -> SIGKILL; Windows
  `taskkill /T /F`). One `deadline = time.time() + args.timeout` is computed
  once; every attempt (initial + agy denial-resumes) gets only what's left,
  including agy's `--print-timeout`. Verified against a real repo
  (checkout/stash) below; did not attempt an artificial hung-child test
  against a *real* CLI (that needs Phase 2's fake-CLI harness) — smoke test
  only exercised the pure-Python logic.
- 1.5: `validate()` replaced with a recursive `validate_schema()` (stdlib
  only) supporting `type` (incl. type lists), `enum`, `required`,
  `properties`, `additionalProperties: false`, `items`, with precise dotted
  paths (verified: `issues[1].severity must be one of [...]`).
- 1.6: top-level `import fcntl` removed; `_lock_file`/`_unlock_file` lazily
  import `fcntl` (POSIX) or `msvcrt` (Windows). Not yet runnable-tested on
  actual Windows (no such machine here) — logic follows Python's
  documented `msvcrt.locking` API; flagged as untested-on-Windows rather
  than a fresh VERIFY (the ground rules only ask for CLI-flag VERIFYs).
- 1.7: docstring rewritten (safe vs skip). Grepped repo for "only when it
  differs", "haiku", "never run with permission checks disabled" — none
  remain outside this checkpoint file itself.

Manually smoke-tested (see shell history in this session): `validate()`
path precision, `check_argv_size()` firing over the guard, `build_command()`
argv shape per CLI (stdin vs pointer), and `git_changes()` against a real
throwaway repo for checkout-revert, tester non-test-file, and
code-reviewer-touched-tree cases. Did not run a real headless dispatch
against a live CLI yet — saved for the Final Verification pass once more
phases land (running it once per phase burns real API/CLI usage).

### Phase 2

- `tests/` (76 tests, all passing locally with `pytest` in a throwaway venv —
  not installed system-wide, per the stdlib-only rule for `bin/`):
  `test_build_command.py` (argv shape x 4 CLIs x 4 roles x safe/skip, stdin
  vs pointer-file, argv-size guard), `test_extract_json.py`,
  `test_validate_schema.py` (against the real schema files),
  `test_git_safety.py` (real temp git repos: commit, stash, `checkout --`,
  `reset --hard`, fetch-only via a second clone pushing to a shared bare
  remote, and an actual push), `test_agy_rules.py` (broken-rule detection,
  missing/malformed settings.json), `test_stream_parsers.py` (against the
  new fixtures), `test_deadline.py` (spawns the real dispatch script against
  a fake CLI that spawns its own child and sleeps past --timeout; asserts
  the whole run finishes near the timeout, not `timeout+60` x resumes, and
  that the grandchild is dead afterward — skipped on Windows, where the
  `taskkill /T /F` path is exercised manually per the ground rules).
- Found and fixed a real bug while writing `test_deadline.py`: on timeout,
  `parse_output()`'s "no result event in output" error was shadowing the
  "timed out after Ns" message entirely (the old `if problem is None` guard
  never ran once `error` was already set). Timeout now always shows up in
  `error`, with any parse error appended in parens.
- Added `CREWBENCH_CLI_OVERRIDE_<CLI>` (checked before falling back to
  `shutil.which`), used by `test_deadline.py`; production path unchanged
  when unset.
- Fixtures under `tests/fixtures/` are hand-written/synthetic, marked as
  such in `tests/fixtures/README.md` (no real CLI output was captured for
  this repo).
- `.github/workflows/ci.yml`: pytest on 3.9/3.12 x ubuntu/macos, a separate
  Windows job (3.9/3.12, same suite minus the POSIX-only deadline test), and
  a `manifests` job running `scripts/check_manifests.py` (new — fails on
  version/description divergence across the three manifests; this is the
  check Phase 9's `bump_version.py` will reuse). Synced `.codex-plugin/
  plugin.json`'s description to match the other two now so this check
  starts green rather than red-until-Phase-9.

### Phase 3

- All four `agents/*.md` briefs get a `## Report format` section (generic —
  "matching your result schema", not the schema text itself). The script's
  `build_prompt` "## How to report" section renamed to "## Running
  non-interactively" and trimmed to not repeat the "must be JSON" sentence,
  just supplying the concrete schema JSON. dispatch.md gained a "Native
  subagent hand-offs" subsection: include the schema in native hand-offs,
  parse trailing JSON the same way the script does, and ask once to
  restate as JSON before giving up and treating the round as failed.
- `schemas/code-reviewer.json`: issues now require a stable `id`
  (`R<round>-<n>`); added an optional `previous_issues[]` (`id`, `status`:
  resolved/still_present, `note`).
- `config/defaults.json` gained `loop: {max_rounds: 3, fix_threshold:
  major}`, merged the same later-wins way as `roles`/`tiers`.
- dispatch.md gained a new `## 5. Diff-aware review and the fix loop`
  section (old §5 Reporting renumbered to §6): round-1 always gets the
  full diff against a remembered base commit; round ≥2 also gets previous
  issues/failures and a delta diff; severity-threshold gating; oscillation
  stop (same file+category issue, or same test, `still_present`/failing
  two rounds running). `skills/new-task/SKILL.md` and `skills/team/
  SKILL.md` updated to match (team now shows/edits `loop` too).
- **Deviation**: 3.2 explicitly says "against the task's base commit — see
  Phase 4" and "once the state exists, store it in state.json" — Phase 4's
  `state.json`/`base_commit` field doesn't exist yet in this phase order,
  so dispatch.md instructs the Team Lead to just remember the base commit
  for the session now, with an explicit forward-reference comment for
  Phase 4 to formalize. Same for the per-round delta-diff snapshot.
- Tests: extended `test_validate_schema.py` fixtures with the new required
  `id` field; added `tests/test_loop_config.py` (defaults.json shape,
  previous_issues validation, bad-status rejection). 79/79 passing.

### Phase 4

- New `bin/crewbench_state.py` (stdlib, imports the lock helper from
  `crewbench_dispatch.py` since both live in `bin/`): `slug` (task-id from
  free text), `new`, `get`, `set <dotted.key> <value>`, `append
  <dotted.key> <value>`, `list`. Every write is atomic + locked and
  upserts `.crewbench/index.json`. Added `schemas/task-state.json`
  documenting the shape (loose `additionalProperties: true` — this file is
  written by our own script, not an LLM, so it doesn't need the strict
  role-schema contract).
- `crewbench_dispatch.py` gained `--task-dir`/`--round`: when given, every
  run artifact (log/prompt/result/raw/resume-prompt) is named
  `<task-dir>/runs/<role>-r<round>.*` instead of being derived from
  `--handoff`'s own filename. `--handoff` alone (no `--task-dir`) still
  works exactly as before — verified via `test_deadline.py`'s existing
  no-task-dir invocation still passing, plus a new
  `test_task_dir_and_round_name_run_artifacts` test.
- `lib/dispatch.md` gained a `## 0. Task folder and state` section
  documenting the layout, task-id/state lifecycle, and the
  `.git/info/exclude` requirement (`tasks/`, `wt/` ignored;
  `team.json`/`project.json`/`project.md`/`index.json` stay committable).
  Section 4's example command and paths updated to the new layout; old
  `.crewbench/runs/...` references replaced throughout (README included).
- All four run-a-task skills (`new-task`, `test`, `review`, `design`) get
  a short addition to "Before you start" pointing at §0 for task-folder
  setup — full de-duplication of this boilerplate is Phase 9's job, this
  phase just adds the new instruction consistently.
- New `skills/status/SKILL.md` (list tasks / one task's full status,
  including live-run PID checks and a `--cleanup` worktree-removal path
  that's inert until Phase 5 creates worktrees) and
  `skills/resume/SKILL.md` (reload state, reconcile dead "running" runs,
  detect a working tree that's drifted from what state implies, continue
  from the current phase without re-asking the lineup). Both read-only
  except `status --cleanup`'s explicit-confirmation worktree removal.
- Synced all three manifests' `description` to also mention `:status` and
  `:resume` (kept `scripts/check_manifests.py` green).
- Tests: `tests/test_state_helper.py` (slug/id generation, new/get/set/
  append/list against the real script as a subprocess, missing-state
  error), plus the task-dir/round dispatch test above. 86/86 passing.
- **Deviation**: `status.json` lives at `<task-dir>/runs/status.json`
  (i.e. inside the `runs/` subfolder, which is itself inside the task
  folder) rather than directly at `<task-dir>/status.json` — the prompt
  says "moves into the task folder" without pinning the exact subpath, and
  keeping it next to the run artifacts it describes (as it already sat
  next to them pre-Phase-4) seemed more useful than a new top-level file.

### Phase 5

- `crewbench_dispatch.py` gained `--cwd` (default: the directory the
  script is run from) and every place that used `os.getcwd()` (agy's
  `--add-dir`, the child process's cwd, both `git_state()` calls) now uses
  it — this is the actual isolation mechanism for headless roles. Updated
  `tests/test_build_command.py`'s fake args to carry `cwd` and assert
  agy's `--add-dir` honors it.
- `config/defaults.json` gained `workspace: {mode: "worktree", setup: [],
  copy: [".env", ".env.local"]}`, merged the same later-wins way as
  `loop`/`roles`/`tiers`.
- `lib/dispatch.md` gained a new `## 5. Worktree isolation (new-task only)`
  section (renumbering old §5/§6 "Diff-aware review"/"Reporting" to §6/§7,
  and fixing every cross-reference in dispatch.md and
  `skills/new-task/SKILL.md` accordingly — double-checked with a grep for
  the old numbers): the pre-flight (base commit, dirty-tree check,
  `git worktree add`, environment setup with confirmation before running
  anything or copying `.env*`), running roles against it (`--cwd` for
  headless; a documented best-effort/no-enforcement caveat for native
  subagents, called out in §3 too), the worktree commit step (merge /
  cherry-pick / leave-the-branch / nothing-yet, replacing the old plain
  commit step), and cleanup (worktree remove + branch delete, wired to
  `/crewbench:status --cleanup`, which was inert until now).
- `new-task/SKILL.md`'s workflow renumbered to insert the pre-flight as
  step 3 and rewrite the commit step (now step 9) around the worktree
  flow, still falling back to the plain in-place flow when
  `workspace.mode` is `in-place`.
- `team/SKILL.md` now shows/edits `workspace` alongside `loop`, and warns
  about the native-subagent/worktree isolation trade-off when the lineup
  mixes them.
- `review/SKILL.md` gained the optional offer (not default) to check out
  the reviewed branch into a detached worktree instead of relying on
  `git show`, per the prompt's Phase 5 item for `review`.
- README's workflow list, team.json example, and layout section updated
  for worktrees/`workspace`; `test`/`review`/`design` documented as always
  `in-place`.
- 86/86 tests still passing (no new test infra needed here beyond the
  `--cwd` assertion above — the worktree *flow* itself is prose/skill
  logic the Team Lead executes with `git`/shell tools, not new script
  code, so there's no additional unit-testable surface in `bin/`).

### Phase 6

Before writing anything, checked every claimed flag/env-var against the
real, installed CLIs on this machine (`claude` 2.1.273, `codex-cli` 0.154.0,
`agy` 1.2.3, GitHub Copilot CLI 1.0.83) rather than guessing — this is the
first phase where I'm literally running *as* one of the four hosts (Claude
Code), so several checks below are real, not simulated.

- **New `bin/crewbench_env.py`** (stdlib): `whoami` prints `{host,
  plugin_root, python, platform, config_dir}`. Host detection: `CLAUDECODE=1`
  is confirmed live (read directly from this session's own environment)
  as Claude Code's marker; codex/agy/copilot have no confirmed "I am
  running inside X" env var (checked `codex --help`, `agy --help`,
  `copilot help environment` — none found), so they fall back to a
  parent-process-name walk (POSIX only, via `ps`; **VERIFY**/untested on
  Windows, same precedent as 1.6's lock helper). `CREWBENCH_HOST_OVERRIDE`
  wins over both for tests/manual override. Plugin-root resolution:
  `CREWBENCH_PLUGIN_ROOT` override → `CLAUDE_PLUGIN_ROOT` if it's a real
  dir → this script's own install location (always correct, since the
  script only ever runs from inside an installed `<root>/bin/`).
  `PLUGIN_ROOT_GLOBS` documents each host's real plugin-cache path,
  confirmed by inspecting this machine's actual installs for
  claude/codex/agy (`~/.claude/plugins/cache/*/crewbench/*`, `~/.codex/
  plugins/cache/*/crewbench/*`, `~/.gemini/config/plugins/crewbench`);
  copilot's is a **VERIFY** guess (`~/.copilot/installed-plugins/...`) since
  no copilot crewbench install existed on this machine to inspect.
- **`crewbench_dispatch.py` additions**: `whoami`'s `CONFIG_DIRS` is
  imported from `crewbench_env.py` (same `sys.path.insert` pattern
  `crewbench_state.py` already used to import from `crewbench_dispatch.py`).
  New subcommands, routed by `sys.argv[1]` before the existing arg parser
  runs (the foreground no-subcommand form is untouched, so every prior test
  still passes unmodified):
  - `doctor --cli <cli>` — installed/version, config-dir writable, a real
    TCP reachability check against each CLI's likely API host (**VERIFY**:
    `NETWORK_CHECK_HOSTS` guesses are not confirmed from CLI docs;
    overridable via `CREWBENCH_NETWORK_CHECK_OVERRIDE_<CLI>` for tests), and
    a login check via each CLI's cheapest non-interactive command — real,
    confirmed live: `claude auth status --json` (`loggedIn`/`email`) and
    `codex login status` (exit 0, "Logged in using ChatGPT"; the *failure*
    exit code is **VERIFY**, only the success case was observed). agy has no
    dedicated status command, so it falls back to `agy models` (a real,
    small network+auth call — also confirmed live); copilot has none
    either, so it falls back to a stored-credential/token-env-var check,
    weaker evidence than an actual call (**VERIFY**). Ran `doctor` for real
    against all four installed CLIs from this session — all four came back
    `ok: true` (see the transcript's tool calls for the raw JSON).
  - `start` / `wait` / `cancel` — the detached-launch-and-poll protocol from
    6.2. `start` just re-execs the same script without `start` in a
    detached process group (`start_new_session=True` POSIX /
    `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS` Windows), so it's the
    exact same code path as the foreground form — results land in
    identical files. `wait` polls `status.json` until every named run is
    `done`/`failed` or `--max-seconds` elapses, returning each run's status
    plus its full envelope if finished. `cancel` kills a run's whole
    process group from outside (new standalone `kill_pid_group`, since
    `cancel` has no live `Popen` handle to `wait()` on the way the
    foreground path's `kill_process_tree` does) and marks it `failed`.
    Manually smoke-tested against a fake CLI: start→wait→done envelope,
    wait-times-out-while-still-running, and cancel actually killing the
    process (checked with `ps`) — all before writing the equivalent pytest
    tests, which now cover the same three cases as subprocess tests.
  - **Recursion guard**: `main()` refuses immediately (before touching any
    CLI) if `CREWBENCH_ROLE` is already set in its own environment. Every
    headless child gets `CREWBENCH_ROLE`/`CREWBENCH_TASK` set via the new
    `child_env()`, which also strips every *other* host's known env-marker
    prefixes (`HOST_ENV_PREFIXES`) so a nested CLI doesn't inherit a
    different host's identity markers. Only `CLAUDECODE`/`CLAUDE_CODE_*` is
    confirmed live; the codex/agy/copilot prefix lists are inferred from
    their own `--help`/env-docs prefixes (`CODEX_`, `ANTIGRAVITY_`/
    `GEMINI_CLI`, `COPILOT_`) — **VERIFY**, not confirmed live the way
    Claude's was, since this session can't actually run as those hosts.
  - `classify_sandbox_error()` — regex signatures for network/EACCES/
    not-logged-in text, prefixed onto `envelope["error"]` when they match,
    per 6.3's "detect typical signatures instead of a generic exit-code
    error" ask.
- **`lib/dispatch.md`**: new "Host detection and plugin root" section
  (before §0); §3 gained a "Per-host dispatch matrix" table (4x4,
  cross-referencing `docs/compatibility.md` for real-verification status
  rather than re-asserting it there); §4's step 2 rewritten around
  `start`+`wait` instead of "background and wait"; two new subsections
  after Commits — "Sandboxes and doctor" and "Nested-agent hygiene" — for
  6.3/6.4. Grepped for the old "background and wait" wording afterward;
  none left outside this checkpoint's own history.
- **New `skills/doctor/SKILL.md`** (`/crewbench:doctor`, read-only): runs
  `doctor` for every non-host CLI in the current lineup, shows one table,
  cross-references `docs/compatibility.md`. `team/SKILL.md` gained a step
  warning when a lineup's role-CLI is `partial`/`unsupported` for the
  detected host per that same doc.
- **New `docs/compatibility.md`**: the 4x4 matrix. Claude-Code-as-host row
  is `verified (real)` for all four columns, but only for `doctor`'s
  checks (installed/reachable/logged-in) — a full real role dispatch or
  `new-task` run was deliberately **not** spent in this pass, same
  deferral-to-Final-Verification policy the checkpoint has used since
  Phase 1 ("running it once per phase burns real API/CLI usage"). Every
  other host row is `partial`: the dispatch script's logic doesn't branch
  on which CLI hosts it, so the same code path is exercised by the
  fake-CLI test matrix below, but this session literally cannot switch
  hosts to prove it, and the doc says so plainly rather than claiming more
  than was actually checked.
- **New `scripts/matrix_smoke.py`** (never run in CI, not run in this pass
  either — same deferral): real local-only smoke test. For `codex` as host
  it uses `codex sandbox -- ...` (free, no model call — confirmed via
  `codex sandbox --help`); for claude/agy/copilot as host it asks that CLI
  (via a small real prompt) to run `doctor` and report its output —
  **VERIFY**, the exact "ask a CLI to run one shell command and print its
  output" invocation per host is inferred from `build_command`'s existing
  flags, not confirmed live for this specific purpose.
- **Tests**: `tests/test_env_helper.py` (host detection incl. override/
  CLAUDECODE/parent-chain fallback, plugin-root resolution, `whoami`
  subprocess), `tests/test_recursion_and_env.py` (refusal when
  `CREWBENCH_ROLE` is set; `child_env()` unit tests; a parametrized 4x4
  host x role-CLI matrix asserting no host's markers ever leak into a
  different CLI's child — this is the "automated 16-combination" ask from
  6.6, done as a focused env/host-detection matrix rather than a full fake
  dispatch x16, since the per-role-CLI dispatch shape is already covered
  per-CLI elsewhere), `tests/test_detached_dispatch.py` (start→wait→done,
  wait-timeout, cancel-kills-the-process-group — the last skipped on
  Windows like the existing deadline test), `tests/test_doctor.py`
  (installed/reachable/logged-in, each failure path, via a fake CLI plus a
  real local TCP listener standing in for network reachability so the test
  suite stays offline-safe), `tests/test_sandbox_signatures.py`. New fake
  CLI fixtures: `quick_success.py` (fast claude-shaped success, used by the
  detached-dispatch tests), `fake_status_cli.py` (branches on argv to stand
  in for whichever status command `doctor` calls). 127/127 passing.
- **`schemas/task-state.json`**: added optional `host_override` and
  `doctor` fields (task-level cache of doctor results per CLI, per 6.3's
  "cache the result per session in the task state"); `crewbench_state.py
  new` now initializes both.
- Synced all three manifests' description to mention `:doctor` (kept
  `check_manifests.py` green); README's blanket "any CLI can hand any role
  to any other CLI" replaced with a pointer to `docs/compatibility.md`, plus
  new sections on the detached start/wait/cancel protocol and
  sandboxes/`doctor`.
- **Deliberately not done in this phase** (all deferred to the project's
  Final Verification pass, per the established per-phase cost policy):
  a real role dispatch or full `new-task` run on any non-Claude-Code host;
  running `scripts/matrix_smoke.py` for real; confirming `codex login
  status`'s failure-case exit code; confirming copilot's actual plugin
  install layout.

### Phase 7

- **`bin/crewbench_profile.py`** existed as untracked work-in-progress from
  before this session's context reset (its `detect`/`agy-rules`
  subcommands, per-ecosystem detectors for node/python/go/Makefile). Found
  and fixed a real bug while reviewing it before building on it:
  `detect_python()`'s pytest-detection line was `any(...) or "pytest" in
  path.read_text() if has_pyproject else False` — Python parses `A or B if
  C else D` as `(A or B) if C else D`, not `A or (B if C else D)`, so (a)
  pytest detection was entirely gated on `has_pyproject` even though
  `pytest.ini`/`conftest.py` are independent signals, and (b) `B`
  (`pyproject.toml.read_text()`) was evaluated unconditionally before the
  ternary resolved, crashing with `FileNotFoundError` whenever only
  `requirements*.txt` existed. Fixed by computing both conditions as named
  booleans first. Regression-tested in `tests/test_profile.py`.
- **New `schemas/project.json`**: documents `.crewbench/project.json`'s
  shape (loose, `additionalProperties: true`, same rationale as
  `task-state.json` — it goes through a human-confirmation step, not the
  strict role-schema contract).
- **New `bin/crewbench_gate.py`** (stdlib): `--cwd --task-dir --round
  [--project-json] [--timeout]`. Reads `commands` from `project.json`
  itself (default `<cwd>/.crewbench/project.json`) rather than taking them
  as a CLI argument — the file is committed, so it's already present in a
  worktree checked out from a commit where it exists. Runs configured
  steps in order (`format_check`, `lint`, `typecheck`, then
  `test_changed`/`test`), **stopping at the first failing step** — the
  prompt didn't specify fail-fast vs. run-all; chose fail-fast since a
  failing lint/typecheck step's output is usually what the next step would
  fail on too, and the developer only needs one fix list per round
  (**deviation**, noted for the final report). Reuses
  `crewbench_dispatch`'s `_terminate_pid_group`/`_hard_kill_pid_group`/
  `GRACEFUL_KILL_TIMEOUT` for the same SIGTERM-then-SIGKILL process-group
  kill on a per-step timeout (default 600s), same import pattern
  `crewbench_state.py` already used. Output tail capped at 200 lines.
  Manually smoke-tested: pass/fail steps, stop-at-first-failure, and a
  real timeout-kills-the-sleeping-child case (`ps` confirmed no orphan)
  before writing the equivalent pytest tests.
- **`lib/dispatch.md`**: fixed two stale "(Phase 6, committable)" labels on
  `project.json`/`project.md` in §0's layout diagram (this repo's own
  phase numbering always called it Phase 7 — see this file's own Status
  table); added a "Project profile" subsection to §0 (first-run detection
  + confirm flow, what feeds the gate, agy-rules are suggestions-only) and
  a "Deterministic gate" subsection to §6 (before the round-1 reviewer
  content, since the gate runs before tester/reviewer within a round).
  Deliberately did **not** renumber dispatch.md's top-level sections to
  fit these in as their own numbered sections — both fit naturally as
  subsections of existing §0/§6, and Phase 5's precedent (a real
  renumber, since worktree isolation didn't fit existing sections) showed
  how much cross-reference churn a renumber costs; grepped for
  `dispatch.md §` afterward to confirm no reference needed updating.
- **`schemas/task-state.json`**: added optional `gate` field to
  `rounds[]` items (the round's `crewbench_gate.py` result, or `null`).
- **`skills/new-task/SKILL.md`**: "Before you start" now triggers
  first-run project-profile detection; inserted a new step 5 (run the
  gate; on failure, fix list back to the developer, no tester/reviewer
  this round) between the old steps 4 (developer) and 5 (tester/reviewer),
  renumbering 5–9 to 6–10.
- **New `skills/profile/SKILL.md`** (`/crewbench:profile
  [show|refresh|edit <change>]`, `disable-model-invocation: true`):
  show reads project.json/project.md; refresh runs `detect`, shows the
  proposal next to what's there, confirms once, then writes (plus agy
  allow-rule suggestions — shown only, never written to
  `~/.gemini/antigravity-cli/settings.json`); edit applies a plain-language
  change after confirmation. Never writes without confirmation, matching
  team/status's style.
- Synced all three manifests' `description` to mention `:profile` (kept
  `check_manifests.py` green); README's command table, `new-task` workflow
  list (added the gate as its own step) and the "first new-task with no
  project.json" note updated.
- Tests: `tests/test_profile.py` (node/python/go detection including the
  pytest-detection regression above, an empty-dir "valid confirmed shape"
  case, `agy_rules_for_commands`' prefix/dedup behavior) and
  `tests/test_gate.py` (no-commands-configured, ordered execution,
  `test_changed` preferred over `test`, stop-at-first-failure, output-tail
  capture, timeout kill — skipped on Windows like the existing
  process-group tests, `--project-json` override). 142/142 passing.
- **Deliberately not done in this phase** (Final Verification): running
  the gate against a real project's real lint/test commands (only
  synthetic `python3 -c ...` steps were exercised); confirming
  `crewbench_profile.py detect`'s output against a real large monorepo.

### Phase 8

Entirely prose/config — no new `bin/` script needed since every piece here
is either a merged config value (already `crewbench_dispatch.py`-agnostic,
resolved by the Team Lead reading JSON directly) or flag-parsing the Team
Lead itself does on `$ARGUMENTS` text.

- `config/defaults.json` gained `"confirm_lineup": "when_unsaved"`,
  merged the same later-wins way as `loop`/`workspace`.
- `lib/dispatch.md` §1 gained two new subsections: "Lineup-confirmation
  setting" (the `confirm_lineup` table: always/when_unsaved/never) and
  "Flags in $ARGUMENTS" (`--yes`, `--design`, `--in-place`, `--rounds N`,
  `--dev <cli[:model]>`, `--review <cli[:model]>` — framed explicitly as
  the existing §1 merge order's third tier, "anything the user tells you
  for this task", expressed as flags instead of a live answer, so no new
  merge mechanism was needed). §2 "Align with the user" rewritten around
  `confirm_lineup`/`--yes` and the "one compact message" rule. Kept every
  section at its existing number — both fit as subsections of §1/§2,
  same non-renumbering approach as Phase 7's profile/gate additions.
- **`skip` launch friction**: new subsection in §4's "Commits" area
  (`~/.claude/settings.json` allow-list check, shown not edited).
  **VERIFY**: the exact glob semantics of Claude's `Bash(...)` allow-rule
  syntax weren't re-derived from a live example this session (this
  machine's own `~/.claude/settings.json` has no `permissions.allow`
  entries to check against) — matched loosely against the pattern the
  original prompt itself suggested, `Bash(python3 */crewbench_dispatch.py
  *)`, not a freshly confirmed one. README's existing "Launching `skip`
  runs from Claude Code" note (already had this exact snippet from an
  earlier phase) updated to say the check is now proactive.
  Also added an explicit "commit/push confirmation is never skippable,
  not even by `--yes` or `confirm_lineup: never`" sentence to §4's
  Commits section, since this had to be true but wasn't said outright
  anywhere before.
- `skills/team/SKILL.md`: shows/validates `confirm_lineup`, saves it
  alongside `loop`/`workspace`, and runs the skip-launch-friction check
  once as part of its own step 1.
- `skills/new-task/SKILL.md`: `argument-hint` lists all six flags;
  "Before you start" strips them from `$ARGUMENTS` before the task text;
  step 2 wired to `--design`/`--yes` and folds the UI/UX + lineup
  questions into one message; step 3 respects `--in-place`; step 8
  mentions `--rounds N`.
- `skills/test/review/design/SKILL.md`: `argument-hint` gained `[--yes]`
  (the only flag that's generic across all skills, since only `new-task`
  loops/worktrees/has a UI/UX question) with a one-line pointer to
  dispatch.md §1.
- Tests: `tests/test_loop_config.py` gained a `confirm_lineup` default
  assertion (no other testable surface changed this phase — everything
  else is prose the Team Lead itself interprets, same as Phase 3's loop
  thresholds and Phase 8's own flags). 143/143 passing.
- **Deliberately not done in this phase** (Final Verification): actually
  invoking `/crewbench:new-task` with each flag combination end-to-end —
  this phase's content is instructions for the Team Lead to follow, not
  code with a unit-testable surface, so it's covered by the Final
  Verification walkthrough (final-verification item 4) rather than pytest.

### Phase 9

- **`bin/crewbench_dispatch.py`** gained `extract_usage(cli, stream,
  stdout, duration_s)` and a new `envelope["usage"]` field, populated
  right after `duration_s`/`session_id`/`resume_command` (same point in
  `main()`), never blocking `finish()` if anything's missing — worst case
  every field but `duration_s` stays `null`. Confirmed shape for
  **claude**: Claude Code's documented `stream-json` terminal `result`
  event's `usage`/`total_cost_usd`/`num_turns` fields (this session didn't
  spend a real prompt to re-capture one live — same per-phase cost policy
  as every prior phase — but the field names are the ones Claude Code's
  own docs specify, not a guess). **VERIFY** (genuinely unconfirmed, no
  live or documented sample found): **agy**'s equivalent `usage`
  sub-object field names — read defensively if agy ever sends one, `null`
  otherwise; **codex**/**copilot** — checked `codex exec --help` for a
  usage-reporting flag/footer and found none documented (there *is* a
  real, confirmed `--json` events flag on `codex exec`, but wiring it in
  would mean parsing a whole new event stream shape for codex, well
  beyond "record any token/usage fields found in current output" — left
  as a follow-up, noted below), so both fall back to a best-effort
  regex scan of plain stdout for a "tokens used"/"total tokens" line,
  landing on `null` when nothing matches (which will be the common case
  today).
- Extended `tests/fixtures/claude_stream.jsonl`'s terminal `result` event
  with `duration_ms`/`duration_api_ms`/`num_turns`/`total_cost_usd`/
  `usage` (documented as still-synthetic, not a fresh live capture, in
  `tests/fixtures/README.md`) so `test_usage.py` has a real fixture to
  extract from rather than hand-built `Stream.final` dicts everywhere.
- **`lib/dispatch.md`**: envelope JSON example (§4) gained the `usage`
  field; new "Usage and timing" subsection right after it (confirmed vs.
  VERIFY status per CLI, the null-is-fine contract, and the exact
  get-then-add-then-set aggregation rule into `state.json.usage.<role>`
  — no new `crewbench_state.py` subcommand needed, since `get`/`set`
  already suffice for "read the current sum, add to it, write it back").
  §7 "Reporting" gained a "Usage summary" subsection with the exact
  one-line-per-role-plus-total format from the phase prompt. Kept every
  section at its existing number (subsections again, same
  non-renumbering approach as Phases 7 and 8).
- `schemas/task-state.json`'s `usage` field description tightened to the
  concrete per-role shape (`runs`, `duration_s`, `tokens`, `cost_usd`,
  `cli`, `model`) and points at the new dispatch.md sections by name
  instead of the old vague "see lib/dispatch.md's usage section" (which
  didn't exist until now).
- `skills/status/SKILL.md` step 2 shows the same usage summary.
  `README.md` gained a short "Usage and timing" subsection mirroring it.
- Tests: `tests/test_usage.py` (claude fixture extraction incl. the
  cost/num_turns/token-sum fields, agy null-when-absent and
  read-if-present, codex/copilot text-scan hit and miss cases). Also ran
  a real end-to-end smoke test with the existing `quick_success.py` fake
  CLI (`CREWBENCH_CLI_OVERRIDE_CLAUDE`) confirming a run with no usage
  data in its fixture still finishes `ok: true` with an all-null-except-
  duration `usage` object — the "never fail on missing usage" contract,
  exercised for real, not just asserted in a unit test. 149/149 passing.
- **Deliberately not done in this phase** (Final Verification, and
  flagged as a real follow-up rather than just deferred): spending a real
  prompt against each of the four installed CLIs to capture their actual
  terminal event/output and confirm or correct the VERIFY items above —
  especially codex's `--json` event stream, which would need its own
  small design pass (a new event-parsing path alongside the existing
  last-message-file one) rather than a one-line fix if it turns out to be
  the right source for codex's usage data.
