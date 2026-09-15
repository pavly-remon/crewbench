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
| 4 Task identity/state/status/resume | pending | |
| 5 Git worktree isolation | pending | |
| 6 Project profile + gate | pending | |
| 7 Less ceremony | pending | |
| 8 Usage/timing report | pending | |
| 9 Maintenance/structure | pending | |
| 10 Optional integrations | pending | |
| 11 Docs and release | pending | |

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
