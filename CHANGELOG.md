# Changelog

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
