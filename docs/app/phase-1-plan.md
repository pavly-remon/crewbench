# Phase 1 — Headless TypeScript engine + CLI (no UI)

Status: **draft — awaiting review**

Read first: `docs/app/CONTEXT.md`, `docs/app/contract/README.md`,
`docs/app/contract/events.md`, `lib/dispatch.md` (all of it — §0–§7),
`skills/new-task/SKILL.md`, all of `bin/*.py`, all of `schemas/*.json`,
`config/defaults.json`, `tests/fixtures/`.

## Goal (unchanged from the phase prompt)

Run the full `new-task` workflow from TypeScript, end to end, in a
terminal: `crewbench run "<task>"`. Parity with the plugin; the state
machine is code, the LLM is used only for scoping, optional handoff
enrichment, and the final summary. Tasks written by the app must be
readable by the plugin (`/crewbench:status`, `/crewbench:resume`) and
vice versa.

## What Phase 1 explicitly does not port

`lib/dispatch.md` §3 ("Pick the dispatch route") spends most of its words
on **native subagent** routing — using a host CLI's own in-process
subagent instead of a headless dispatch. `docs/app/CONTEXT.md`'s
non-negotiable principle 5 rules this out for the app entirely ("no
native in-process subagents in the app. Everything runs headless."). So:

- The per-host dispatch matrix, the native-subagent hand-off/parsing
  rules, and the Copilot-custom-agent-model-override check are **plugin-only
  concepts** — they describe what the *LLM Team Lead* does when it happens
  to be a CLI with its own subagent mechanism. The app has no such thing;
  every role, on every CLI, goes through the adapter's headless path,
  always. This actually simplifies the engine relative to the plugin: no
  route decision, no native-vs-headless result-shape reconciliation.
- `crewbench_env.py`'s host-detection logic (`whoami`, the `ps` ancestor
  walk, `CLAUDECODE=1` sniffing) answers "which CLI am I running inside,
  right now" — a question that only makes sense for a plugin skill that
  *is* the Team Lead's own LLM turn. The app is a standalone Node process;
  it doesn't run "inside" a CLI. It still needs to pick *a* CLI to make
  the scoping/summary LLM calls through (§0's "LLM Team Lead calls" in the
  Phase 1 prompt) — that's a user/config choice (which CLI is the "lead"
  for this task), not host detection. `crewbench_env.py check_model()` (the
  model-freshness check) is genuinely reusable and gets ported into the
  adapters' `doctor()`.

## Design decisions

1. **Package manager & Node.** `pnpm` via Corepack (already enabled on
   this machine: `corepack enable` → pnpm 12.4.2). Root `package.json` pins
   `"packageManager": "pnpm@12.4.2"`. Node: `docs/app/CONTEXT.md` says
   "current active LTS, don't assume" — checked live (2026-09-19): **Node
   24 is Active LTS**; Node 22 (installed on this machine, v22.22.1) moved
   to Maintenance LTS in late 2025 and is supported until 2027-04-30, so
   it still works for local dev, but `engines` and CI both target Node 24.
   Milestone 1 installs Node 24 locally (`fnm` is already on this machine)
   before scaffolding, so `pnpm install` and every later milestone run
   against the same version CI will use.
2. **TypeScript 7** (`typescript@7.0.2`, the native-compiled "Corsa"
   rewrite) is the current stable release, not a preview — confirmed via
   npm's `latest` dist-tag, not assumed. It's young enough that some
   ecosystem tooling (editor plugins, certain lint integrations) may lag;
   flag this explicitly in milestone 1 rather than discovering it mid-way
   through later milestones. If real friction shows up, the fallback is
   pinning `typescript@~5.9` instead — a plan-level decision to revisit
   there, not something to silently swap.
3. **zod v4** (`zod@4.6.5`) has first-party `z.toJSONSchema()` — no
   separate `zod-to-json-schema` dependency needed (that package is
   unmaintained since Zod v4 shipped its own converter). Simplifies
   `packages/contract`'s generation script to zod + a thin CLI wrapper.
4. **vitest v5**, **fastify v5** — current stable, matches the stack
   `docs/app/CONTEXT.md` already named.
5. **Monorepo tooling beyond pnpm workspaces**: none yet. No Turborepo/Nx —
   6 packages with a linear dependency chain (contract → adapters → engine
   → {daemon, cli}) don't need a build orchestrator yet; `tsc -b` project
   references are enough. Revisit only if build times become a real
   problem, and call it out in a plan update rather than adding it
   silently.
6. **ESM throughout**, per `docs/app/CONTEXT.md`. Each package:
   `"type": "module"`, TS `"module": "nodenext"`.
7. **Contract package owns process spawning helpers?** No — `packages/contract`
   is schemas/types/fixtures only, zero runtime I/O. Process spawning
   (detached launch, process-group kill, tree-kill semantics matching the
   Python implementation) belongs in `packages/engine`'s runner, mirrored
   from `crewbench_dispatch.py`'s `_terminate_pid_group`/
   `_hard_kill_pid_group`/`kill_pid_group` — Node's `child_process` needs
   `detached: true` + `proc.unref()` on POSIX and
   `spawn(..., {windowsHide: true})` with `taskkill /T /F` for the
   Windows tree-kill, since Node has no direct equivalent of Python's
   `os.killpg`.
8. **Codex/copilot's newly-real structured output (Phase 0 milestone 4)
   is the baseline the TS adapters port from** — not the old
   text-scan/VERIFY behavior. The TS `codex` adapter uses `--json` +
   `Stream._codex()`'s event shapes from day one; the `copilot` adapter
   uses `--usage-output-file` from day one. Porting the *old* Python
   behavior here would mean re-doing Phase 0's investigation work in
   reverse.
9. **golden tests**: port `tests/fixtures/*.jsonl`/`.txt`/`.json` as-is
   (same files, read from the TS side too — `packages/adapters/` reads
   `../../../tests/fixtures/` relative to the repo root, not a
   duplicated copy) so a fixture only has to be updated once when a CLI's
   shape changes.
10. **No custom roles in Phase 1** (out of scope per the prompt) — the
    engine's issue registry, loop rules and result-merging are written
    against exactly `developer`/`tester`/`code-reviewer`/`ui-ux`, matching
    `schemas/*.json` today. Phase 5 generalizes this; Phase 1 doesn't
    pre-abstract for it.

## Target layout (this phase's slice of `docs/app/CONTEXT.md`'s full one)

```
app/
  package.json              (workspace root, private, packageManager pin)
  pnpm-workspace.yaml
  tsconfig.base.json
  .nvmrc / .node-version     (24)
  packages/
    contract/
      src/
        schemas/             (team, project, state, index, status, envelope,
                              developer/tester/code-reviewer/ui-ux results,
                              events (discriminated union), task-spec (NEW))
        codex-strict.ts       (port of codex_strict_schema() + null-normalization)
        index.ts
      scripts/generate-json-schema.ts   (zod -> schemas/*.json, CI-checked)
      test/                  (vitest; golden fixtures read from repo-root tests/fixtures/)
    adapters/
      src/
        types.ts              (the one CliAdapter interface)
        claude.ts / codex.ts / agy.ts / copilot.ts
        stream.ts              (shared line-classification, mirrors classify_log_entry)
        usage.ts
        doctor.ts
        resume.ts
      test/
    engine/
      src/
        reduce.ts / decide.ts   (pure state machine)
        loop-rules.ts           (gate short-circuit, threshold, stuck, max-rounds)
        issue-registry.ts
        runner.ts               (spawns adapters, writes contract files)
        git.ts                  (worktree pre-flight, snapshots, warnings)
        gate.ts                 (port of crewbench_gate.py)
        profile.ts              (port of crewbench_profile.py)
        handoffs.ts             (deterministic templates)
        llm.ts                  (scoping + summary calls, via an adapter)
        approvals.ts
        concurrency.ts
      test/
    cli/
      src/
        bin.ts
        commands/ (run, status, resume, cancel, doctor, team, profile)
      test/
```

`packages/daemon` and `packages/ui` are Phase 2 — not created yet, but the
workspace root's `pnpm-workspace.yaml` glob (`packages/*`) already
accommodates them without changes later.

## Milestones

Mapped 1:1 to the phase prompt's own list, each ending in its own
commit(s), passing tests, and a note appended below.

### 1. Workspace scaffold, contract package, JSON Schema generation + CI check

- Install Node 24 (fnm), enable Corepack, `pnpm init` the workspace.
- `packages/contract`: zod schemas for `team.json`, `project.json`,
  `state.json` (incl. `schema_version`, the new id shape — see
  `docs/app/contract/README.md`), `index.json`, `status.json`, the result
  envelope, each role result (ported field-for-field from
  `schemas/*.json`), `events.jsonl`'s discriminated union (ported from
  `docs/app/contract/events.md` — 11 event types), and the **new**
  `task-spec` schema (`title`, `description`, `acceptance_criteria[]`,
  `affected_areas[]`, `out_of_scope[]`, `needs_design`, `design_notes?`,
  `jira_key?`, `constraints[]`).
- `codex_strict_schema()` port: every property required, optional fields
  unioned with null (port the exact transform, not a reinterpretation —
  see `crewbench_dispatch.py:214`), plus `normalize_optional_nulls()`'s
  read-side counterpart. Port `tests/test_codex_strict_schema.py`'s cases
  as vitest cases against the TS version, same inputs/outputs.
- `scripts/generate-json-schema.ts`: `z.toJSONSchema()` each schema,
  write to the **existing** `schemas/*.json` (root of the repo, not a
  copy under `app/`) so `crewbench_dispatch.py`'s `validate()` keeps
  reading the same files. A CI job runs the generator and fails the build
  if `git diff` is non-empty (source of truth is the zod schema; the JSON
  file is generated, checked in, and drifts are a CI failure, not a
  silent merge).
- Node CI job added to `.github/workflows/*.yml` (a new job, or a new
  workflow file matching the existing per-OS Python matrix's shape) running
  on Linux/macOS/Windows: `corepack enable`, `pnpm install`, `pnpm -r build`,
  `pnpm -r test`, then the schema-generation-drift check.

### 2. Adapters with golden tests from the existing fixtures, plus doctor

- One file per CLI implementing a single `CliAdapter` interface:
  `buildCommand`, `parseLine -> NormalizedEvent[]`, `finalResult`,
  `extractUsage`, `resumeCommand`, `doctor`.
- Port, exactly, from `crewbench_dispatch.py` (this phase's biggest
  faithfulness risk — every one of these is a "don't guess, verify
  against real output" item per `docs/app/CONTEXT.md` principle 8, and
  Phase 0 already did the codex/copilot verification this phase inherits):
  - permission-mode/flag tables per CLI×role (the `safe`/`skip` tables in
    `lib/dispatch.md` §4).
  - `CLAUDE_TOOLS`, `LIMITS`, `READ_ONLY`, `AGY_DENIAL_RESUMES` (2),
    `NO_EFFORT`, `MAX_ARGV_BYTES` (100_000), the argv-size guard with
    prompt-file fallback.
  - the recursion guard (`CREWBENCH_ROLE` env var check — refuse to run if
    already set) and `HOST_ENV_PREFIXES` stripping.
  - sandbox-error classification (`classify_sandbox_error`'s regex table).
  - the four `doctor()` checks (installed/version, config-dir writable,
    network, auth) including each CLI's specific auth-check command
    (`claude auth status --json`, `codex login status`, agy's `agy
    models` fallback, copilot's weaker credential-file check) and
    `check_model()` (model-freshness, ported from `crewbench_env.py`).
- `Stream`-equivalent line classification per CLI, matching
  `classify_log_entry()`'s event-type mapping (`run.message`/
  `run.tool_call`/`run.tool_error`) from Phase 0 milestone 3 — this is
  where `events.jsonl` compatibility actually lives, so the TS parser must
  produce the *same classification*, not just "similar."
- Golden tests: feed every `tests/fixtures/*.jsonl`/`.txt`/`.json` file
  through the TS parser and assert the same facts the Python
  `test_stream_parsers.py`/`test_usage.py`/`test_build_command.py` suites
  assert (session id, denied commands, final result, usage numbers).
  Direct file-by-file parity, not just "produces something reasonable."

### 3. Engine core: reduce/decide + loop rules + issue registry

- `reduce(state, event) -> state` and `decide(state) -> Command[]`, pure,
  no I/O — this is the part of the plugin that today lives entirely in
  an LLM's judgment (`skills/new-task/SKILL.md`'s numbered workflow) and
  becomes real, tested code. Phases:
  `scoping → [design] → implementing → verifying → fixing →
  awaiting_commit → done | stopped | failed`, matching
  `schemas/task-state.json`'s enum exactly (any internal-only phase, if
  one turns out to be needed, must still map back to one of these on
  read, so a plugin-side `/crewbench:status` never sees an unknown phase).
- Loop rules, each a named, independently tested pure function, one per
  rule in `lib/dispatch.md` §6:
  - gate short-circuit (fails → fix list, skip tester/reviewer, still
    counts as a round).
  - severity threshold (`tester.verdict != pass` OR a reviewer issue/
    `previous_issue.still_present` at or above `loop.fix_threshold`).
  - combined fix list (tester failures + reviewer issues, one list, one
    round — never two separate loops).
  - `max_rounds` cap (task-level `--rounds` override wins over
    `team.json`'s `loop.max_rounds` wins over `config/defaults.json`'s 3 —
    same later-wins merge as §1).
  - stuck/oscillation detection: same `file`+`category` issue
    `still_present` two rounds running, or the same `test`+`file` failing
    twice.
  - below-threshold issues → `optional_follow_ups`, never sent back.
- Issue registry: the engine assigns ids (`R<round>-<n>`, matching
  `schemas/code-reviewer.json`'s documented convention) and owns identity
  across rounds — a round's `previous_issues[]` matched by id first, falling
  back to file+category+similar-title when a role's response doesn't echo
  the id back verbatim (record which method matched, for later
  debugging/observability).
- Target: every named rule above has its own named test — the milestone's
  actual acceptance bar, not just "engine has decent coverage."

### 4. Runner + git + gate + profile, integration-tested with fake CLIs

- Runner: executes `Command`s from `decide()`. Spawns adapters detached
  (see Design decision 7 for the cross-platform kill semantics), writes
  `status.json`/`events.jsonl`/`.log`/`.result.json` in the **exact**
  contract layout from `docs/app/contract/README.md` (byte-compatible
  paths and JSON shapes — a plugin-side `/crewbench:status` on an
  app-created task is Phase 1's actual acceptance test, not a nice-to-have).
  Tester + code-reviewer run in parallel (`start` both, one combined
  wait), matching `lib/dispatch.md` §4 point 4. Supports cancel
  (process-group kill) and a per-run timeout, matching
  `crewbench_dispatch.py`'s single-deadline-across-agy-resumes rule.
- Git: worktree pre-flight (`base_commit`, dirty-tree check, `git
  worktree add .crewbench/wt/<id> -b crew/<id> <base_commit>`, or the
  Jira-key naming form, `workspace.copy`/`workspace.setup`), before/after
  snapshots with the **same** warning conditions as
  `crewbench_dispatch.py`'s `git_changes()` (HEAD moved, branch switched,
  stash changed, previously-dirty files reverted/deleted, a read-only role
  changed anything, tester touched a non-test file), delta diffs per
  round, commit on the task branch, cleanup. Port `test_git_safety.py`'s
  cases as vitest cases against the same fixture git repos (fixture setup
  can be a small shared shell/TS helper, not duplicated per-language
  fixture data).
- Gate: port `crewbench_gate.py` field-for-field — same `_split()` quoting
  fix (posix=False tokenize + manual quote-stripping — the exact bug this
  fixed, per that function's docstring, must not regress), same
  step-order/skip-if-unconfigured/stop-on-first-failure semantics, same
  `gate.finished` event emission.
- Profile: port `crewbench_profile.py`'s detection (Node/Python/Go/Make,
  `agy_allow_rules`) field-for-field against `schemas/project.json`.
- Integration tests against fake CLIs: reuse
  `tests/fixtures/fake_clis/*.py` as external scripts the TS runner
  actually spawns (via `CREWBENCH_CLI_OVERRIDE_<CLI>`, the same env var
  the Python tests use) rather than rewriting them in TS — one fewer
  thing to keep in sync between languages, and proves the TS runner's
  spawn/timeout/cancel logic against the exact same fixtures the Python
  suite already trusts.

### 5. Scoping + summary LLM calls + approvals + terminal CLI

- Scoping: an interactive, multi-turn conversation with the lead CLI
  (picked via config/flag, not detected — see "What Phase 1 explicitly
  does not port"), using that adapter's session-resume mechanism per
  turn, ending in a schema-valid `task-spec`. This is the one piece of
  Phase 1 with no direct Python precedent (the plugin's Team Lead does
  this as its own LLM turn, with no separate "task-spec" artifact) — the
  scoping *questions* mirror `skills/new-task/SKILL.md` steps 1–3 (Jira
  key detection, clarifying questions, the UI/UX opt-in question), but the
  mechanism (a real subprocess conversation via an adapter) is new.
- Final summary: deterministic-first (assemble from final state, matching
  `lib/dispatch.md` §7's "Usage summary" format exactly), with an LLM call
  only to turn that into plain language — and a hard deterministic
  fallback if that call fails, so a task's outcome is never unreported
  over an LLM-call hiccup.
- Approvals: `approval.requested`/`approval.resolved` events, kinds =
  `confirm_profile`, `lineup`, `design`, `dirty_tree`, `worktree_setup`,
  `commit`, `push`, `integrate`, `cleanup_worktree`. `commit`/`push`
  **cannot** be auto-resolved by any code path — enforce this as a
  hard-coded engine invariant (a test that tries to auto-resolve one and
  asserts it's rejected), not just a convention followed by callers.
- Terminal CLI: `crewbench run "<task>" [--spec ...] [--yes] [--design]
  [--in-place] [--rounds N] [--dev cli[:model]] [--review cli[:model]]`
  (same flags as the plugin's `lib/dispatch.md` §1 table), approvals
  resolved via terminal prompts.

### 6. Resume/cancel/concurrency + cross-compat tests

- Resume: rebuild state by replaying `events.jsonl` (falling back to
  `state.json` alone for a plugin-created task, which may have no events
  file at all — see `docs/app/contract/events.md`'s "Legacy tasks"
  section). Detect a run marked `running` in `status.json` whose pid is
  dead (mirrors `/crewbench:resume`'s step 3) and offer to re-dispatch.
- Concurrency limiter: per-CLI max concurrent runs (default 2, from
  config), queuing with `run.queued`/`run.dequeued` events (the latter is
  new — not in Phase 0's event catalog, since nothing queued before this
  phase; add it to `docs/app/contract/events.md` when this milestone
  lands).
- **Cross-compat tests** (this milestone's actual point, and Phase 1's
  headline compatibility risk): create a task with
  `crewbench run`, read it with `crewbench_state.py get`/`list`; create
  one with `crewbench_state.py new`, resume it with the TS `resume`
  command. Both directions, automated, not just "should work in
  principle."

### 7. Real end-to-end run + `docs/compatibility.md` update

- A throwaway repo, mixed lineup (Claude lead, agy developer, codex
  reviewer, per the phase prompt's example) — a genuinely real run
  against real, logged-in CLIs, the same way Phase 0's milestone 4 was
  verified live rather than assumed. Record the result in
  `docs/compatibility.md`, alongside the existing 4×4 host×role matrix and
  Phase 0's structured-events findings.

## Files touched (new, this phase)

Everything under `app/` (new tree, per the target layout above);
`.github/workflows/*.yml` (new Node CI job); `docs/compatibility.md`,
`docs/app/contract/events.md` (append `run.queued`/`run.dequeued` when
milestone 6 lands). **No existing `bin/*.py`, `schemas/*.json`,
`lib/dispatch.md` or `skills/*/SKILL.md` file changes** — Phase 1 reads
the plugin's behavior as spec and ports it; it doesn't modify plugin
behavior (that's explicitly out of scope, same as Phase 0's "no workflow
changes").

## Open questions

1. **TypeScript 7 risk.** It's the current stable release, but young
   (native-compiled rewrite) — milestone 1 is where any real ecosystem
   friction (editor/lint plugin lag, an `@types/*` package assuming
   TS 5/6 internals) would surface first. Flagging now so a mid-milestone
   pin-down to `typescript@~5.9` isn't a surprise if it's needed; will
   report back either way once the scaffold is up.
2. **Lead-CLI selection for scoping/summary calls.** Needs a decision
   *this phase* (unlike the plugin, which never asks — the Team Lead's
   own host answers it implicitly). Proposed default: a `--lead
   <cli[:model]>` CLI flag, defaulting to whichever of the four CLIs
   `doctor` finds installed+logged-in first in a fixed preference order
   (`claude, codex, agy, copilot`) if not given. Flagging for explicit
   confirmation before milestone 5, since it's user-facing behavior with
   no existing plugin precedent to match.
3. **Task-spec's relationship to `state.json`.** The Phase 1 prompt says
   `state.json` "points to it" — proposing a new `spec_file` field
   (parallel to the existing `design_spec_file`) rather than overloading
   `design_spec_file` itself, since a task-spec and a design spec are
   different artifacts with different producers (engine-only scoping vs.
   the ui-ux role). Needs a `schemas/task-state.json` update — this is the
   one place Phase 1 *does* touch a root-level schema file, since
   `additionalProperties: true` there means it's additive, not breaking,
   for the plugin's own (unaware) readers.
4. **CI workflow structure.** Add a Node job to the existing Python
   workflow file, or a separate `ci-node.yml`? Leaning separate file (the
   Python matrix is already 2 OS × 2 Python versions; interleaving a
   third language's job into the same YAML risks an unrelated edit
   breaking both) — confirming before milestone 1 writes it.

## Milestone log

### Milestone 1 — done (2026-09-19)

- Installed Node 24.21.0 via `fnm` (`fnm install 24 && fnm default 24`),
  enabled Corepack (pnpm 12.4.2). `app/.node-version` pins `24` for the
  workspace.
- Scaffolded `app/` as a pnpm workspace: root `package.json`
  (`packageManager` pin, `engines.node >=24`), `pnpm-workspace.yaml`
  (with `allowBuilds.esbuild: true` for vitest's esbuild dependency —
  pnpm 12 now blocks postinstall scripts by default and this was the one
  legitimate one needed), `tsconfig.base.json` (ES2023, `nodenext`,
  strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`,
  `composite: true` for `tsc -b` project references).
- `packages/contract`: zod v4 schemas for every file in
  `docs/app/contract/README.md`'s inventory — `team.json` (no Python-side
  JSON Schema existed; ported from `config/defaults.json`'s shape and
  `lib/dispatch.md` §1), `project.json`, `state.json` (including the new
  `spec_file` field per the resolved open question 3, and
  `schema_version` as optional-meaning-legacy-0), `index.json` entries,
  `status.json` entries (no Python schema file either — ported from
  `update_status()`'s actual usage sites), the dispatch envelope, all
  four role results (with `.describe()` calls preserving the original
  schemas' field descriptions), the `events.jsonl` discriminated union
  (11 event types from `docs/app/contract/events.md`), and the new
  `task-spec` schema.
- Ported `codex_strict_schema()`/`normalize_optional_nulls()` field-for-
  field into `codex-strict.ts`, operating on plain JSON-Schema objects
  (not zod schemas — codex's `--output-schema` takes a JSON Schema file).
  `test/codex-strict.test.ts` ports every case from
  `tests/test_codex_strict_schema.py` against the same fixture files (the
  real root `schemas/*.json`), not reimplemented fixtures.
- `scripts/generate-json-schema.ts`: `z.toJSONSchema()` each schema,
  writes to the existing root `schemas/*.json` (not a copy under `app/`).
  **Caught and fixed a real correctness bug before it shipped**: zod
  represents a nullable integer union (`z.union([z.number().int(),
  z.null()])` — used by `issues[].line`, gate `exit_code`, envelope
  `num_turns`) as `anyOf: [{type, minimum, maximum}, {type: "null"}]`,
  not the `type: [T, "null"]` array form the hand-written schemas use.
  `crewbench_dispatch.py`'s hand-rolled `validate_schema()` only reads
  `schema.get("type")` — it has no `anyOf` support — so an uncollapsed
  `anyOf` silently made that field's type check a no-op, accepting *any*
  value instead of rejecting a non-integer, non-null one. Verified the
  failure mode live (`validate()` accepted `"line": "not-a-number"`
  before the fix, correctly rejected it after) before writing the fix.
  Added `json-schema-postprocess.ts`'s `collapseNullableAnyOf()`
  (extracted from the script into the package proper so it's directly
  testable) plus 5 regression tests, one of which reproduces the exact
  bug shape from a bare zod schema (not just the fixed output) so a
  future zod upgrade that changes this behavior would be caught. Also
  normalizes `additionalProperties: {}` (zod's `z.unknown()`/`z.record()`
  output) to the boolean `true` the hand-written files use — functionally
  identical to Python's validator either way, but matches convention.
  Regenerating is idempotent (confirmed: running it twice produces no
  further diff) and the full Python suite (212 tests) still passes
  against the regenerated files.
- The four role-result schemas' regenerated diff is now purely cosmetic
  (description-key reordering only); `task-state.json`/`project.json`'s
  diffs are real (the new fields, reformatted). Neither file is ever fed
  through Python's `validate_schema()` (confirmed by grep — only
  `schemas/<role>.json` is), so their JSON Schema is documentation-grade,
  not executable-validation-grade, and the one remaining `anyOf` there
  (`rounds[].gate`, a full-object nullable union `collapseNullableAnyOf`
  correctly declines to flatten) is harmless.
- Added `.github/workflows/ci-node.yml` as a **separate** workflow file
  from the existing Python `ci.yml` (open question 4, resolved): a
  3-OS `test` job (build + test + typecheck) and a `check-schemas` job
  that fails if regenerating drifts from the committed `schemas/*.json`.
- Full verification before commit: `pnpm -r typecheck`, `pnpm -r build`,
  `pnpm -r test` (25 TS tests) all green; `python3 -m pytest tests/`
  (212 tests) green against the regenerated schema files;
  `pnpm check:schemas` correctly detects drift (confirmed by running it
  against the pre-commit working tree, where it correctly failed showing
  the real diff, then confirmed clean once the regenerated files matched).
- Open question 1 (TypeScript 7 risk): no friction hit yet — `tsc -b`,
  `vitest`, and `tsx` all worked against TS 7.0.2 without issue in this
  milestone. Continuing with it; will flag here if that changes.

### Milestone 2 — done (2026-09-19)

- New `packages/adapters` (depends on `@crewbench/contract`). **Deviation
  from the target layout's literal file list, disclosed here rather than
  silent**: instead of one file per CLI (`claude.ts`/`codex.ts`/`agy.ts`/
  `copilot.ts`) each implementing a separate `CliAdapter`, every piece of
  logic is a single function parametrized by `cli` (`buildCommand()`,
  `Stream`, `extractUsage()`, `resumeCommand()`, `doctor()`) — mirroring
  `crewbench_dispatch.py`'s own structure (one script branching on
  `--cli`, not four near-identical scripts). A thin `createAdapter(cli)`
  in `adapter.ts` assembles these into the `CliAdapter` object shape the
  plan named, so milestone 4's runner still gets a clean per-CLI handle;
  the underlying logic isn't duplicated four times. Chose this because
  "port field-for-field" and "four separate files" pulled in opposite
  directions here — fidelity to the actual source structure won.
- Ported, field-for-field, every piece `lib/dispatch.md` §4 and
  `crewbench_dispatch.py` describe: `childEnv()`/`HOST_ENV_PREFIXES`
  (env.ts), `checkArgvSize()`/`MAX_ARGV_BYTES` (argv.ts), `extractJson()`/
  `short()` (json-extract.ts, including the raw-decode-style scanner for
  "last top-level JSON object in free text", since JS's `JSON.parse` has
  no partial-parse mode like Python's `raw_decode`), `resumeCommand()`
  (resume.ts, including the codex fix from Phase 0 milestone 4),
  `classifySandboxError()` (sandbox.ts), `resolveCliPath()`/
  `cliArgvPrefix()`/`CONFIG_DIRS` (cli-paths.ts), `LIMITS`/
  `CLAUDE_TOOLS`/`agyCommandRules()`/`limitsFor()` (limits.ts),
  `buildPrompt()`/`stripFrontmatter()`/`promptPointer()` (prompt.ts), the
  full `Stream` class for all four CLIs plus `classifyLogEntry()`
  (stream.ts), `extractUsage()` (usage.ts, including copilot's
  `--usage-output-file` read and codex's real `turn.completed` usage from
  Phase 0), `parseOutput()` (parse-output.ts), `buildCommand()` for all
  four CLIs (build-command.ts), the doctor checks — network/auth/
  config-dir-writable — and `checkModel()` from `crewbench_env.py`
  (doctor.ts, model-check.ts).
- `checkModel()`'s closest-match ranking uses a small Levenshtein-based
  similarity function, not Python's `difflib.get_close_matches()` (no
  direct equivalent in the stack without a new dependency) — same
  purpose (best-effort fuzzy suggestions for a doctor-report hint,
  nothing else depends on exact ranking), not byte-identical algorithm.
  Documented inline; flagging here too since it's a real, if minor,
  algorithmic deviation.
- Golden tests reuse the **same fixture files** `tests/fixtures/` already
  has (read via a relative path up to the repo root, not copied) for
  every CLI's stream parser, `parse_output`, `extract_usage`, and the
  `codex_last_message.json`/`copilot_stdout.txt` extraction cases — ported
  one-to-one from `test_stream_parsers.py`/`test_usage.py`. `doctor()`'s
  integration tests spawn the real `tests/fixtures/fake_clis/
  fake_status_cli.py` fixture (same file the Python suite spawns), proving
  the TS `doctor()` drives an external process identically, not just that
  it parses fixture text. `agyCommandRules()`'s tests port
  `test_agy_rules.py` exactly, using a `home` parameter override instead
  of monkeypatching `Path.home()` (no direct TS equivalent of Python's
  `monkeypatch.setattr`, so the function takes an optional override
  param instead — a deliberate, tested seam rather than a global-state
  workaround).
- Caught one real bug while writing `doctor()`'s integration tests: the
  fixture-file path was computed relative to `process.cwd()` (which is
  wherever vitest happens to run from) instead of the test file's own
  location, so it silently resolved to a nonexistent path and every
  doctor-with-a-real-fake-CLI test failed with ENOENT. Fixed by switching
  to `import.meta.url`-based resolution, matching every other test file
  in this package.
- Added a `tsconfig.test.json` per package (contract and adapters) so
  `pnpm typecheck` actually type-checks test files too — `tsc -b`'s
  `include: ["src"]` alone left every `test/*.ts` file completely
  unchecked by the build; vitest's esbuild transform doesn't type-check
  either. Wired into each package's `typecheck` script.
- Full verification: `pnpm -r typecheck` (now covering tests too),
  `pnpm -r build`, `pnpm -r test` (132 TS tests: 25 contract + 107
  adapters) all green; the Python suite (212 tests) still green
  (unaffected by this milestone — adapters is new code, not a port that
  touches `bin/*.py`).

### Milestone 3 — done (2026-09-19)

- New `packages/engine` (depends on `@crewbench/contract`). Phases match
  `schemas/task-state.json`'s enum exactly (no extra internal-only phase
  was needed): `scoping → [design] → implementing → verifying → fixing →
  awaiting_commit → done | stopped | failed`. `implementing` is round 1;
  any later round (whether reached via a failing gate or a fix-worthy
  verification round) is `fixing` — this wasn't spelled out verbatim
  anywhere in `lib/dispatch.md`/`skills/new-task/SKILL.md`, so it's an
  inference from the phase names themselves, flagged here rather than
  silently assumed.
- `loop-rules.ts`: every rule in `lib/dispatch.md` §6 as its own named,
  pure function — `gateShortCircuit`, `severityThresholdReached`,
  `combinedFixList`, `belowThresholdFollowUps`, `maxRoundsReached`,
  `stuckDetection`. Each has its own `describe()` block in
  `test/loop-rules.test.ts` naming the §6 subsection it ports, per the
  milestone's own acceptance bar ("every rule ... has a named test").
- `issue-registry.ts`: the engine (not the reviewer) assigns issue ids
  (`R<round>-<n>`) and owns identity across rounds. `matchPreviousIssues()`
  matches a reviewer's `previous_issues[]` back to the registry by id
  first, falling back to file+category+title-similarity (a small
  word-overlap heuristic — the reviewer's `note` field stands in for a
  "title", since there's no separate title field in the schema), and
  records which method matched. `updateRegistry()` advances the registry
  each round: new issues become `open`, matched-resolved entries reset
  their streak, matched-still_present entries increment
  `consecutiveStillPresent` (what `stuckDetection()` actually reads).
- `reduce.ts`/`decide.ts`: the pure `reduce(state, event) -> state` /
  `decide(state) -> Command[]` pair the milestone calls for, with zero I/O
  in either. `reduce()` mirrors `skills/new-task/SKILL.md`'s steps 4-11
  turned into code; `decide()` derives the next `Command` purely from
  current state (never from the triggering event), so a resumed/replayed
  state produces the same next action regardless of how it got there --
  relevant for milestone 6's resume-from-events-jsonl work later in this
  phase.
- **A real bug caught by my own test, not by inspection**: my first
  `reduce.test.ts` case for "same issue still_present two rounds running"
  reported `still_present` only *once* and expected the engine to call it
  stuck immediately. It correctly didn't — `lib/dispatch.md` §6 says
  "still_present for two consecutive rounds", meaning two consecutive
  *reports* of still_present, not one. Fixed the test to report
  `still_present` twice before asserting `stopped`, rather than loosening
  the rule to match a wrong test — the code was right, the test's
  understanding of the rule was off by one round.
- Full verification: `pnpm -r typecheck/build/test` all green (180 TS
  tests total: 25 contract + 107 adapters + 48 engine); the Python suite
  (212 tests) unaffected and still green.

### Milestone 4 — done (2026-09-19)

- `contract-fs.ts`: the TS-side counterpart of `crewbench_fs.py` --
  `nowIso()`/`parseLegacyOrUtc()` (byte-identical timestamp format to the
  Python side), `atomicWriteJson()`, `appendEvent()` (same events.jsonl
  line shape, same seq-from-last-line approach). **A disclosed, real
  limitation, not silently glossed over**: the locking primitive is an
  exclusive-lockfile mutex (atomic `open(path, "wx")`, polled, with a
  staleness timeout), not Node's equivalent of POSIX `fcntl.flock`/
  Windows `msvcrt.locking` -- Node has no built-in binding for either.
  This guards concurrent *Node-side* writers (a tester run and a reviewer
  run finishing at once, both from this same runner process) but not
  simultaneous access from a live Python process and a live Node process
  at once. Scoped as acceptable for Phase 1 under
  `docs/app/CONTEXT.md`'s single-owner-at-a-time model (a task is
  plugin-owned or app-owned, not both simultaneously) -- flagged here as
  a real design decision for Phase 3's ownership work to revisit, not
  something quietly assumed equivalent.
- `gate.ts`: `crewbench_gate.py` ported field-for-field, including
  `shellSplit()` (the exact `_split()` quoting fix -- POSIX-mode
  tokenizing mangles Windows backslash paths, non-POSIX-mode leaves quote
  characters in each token; the fix tokenizes non-POSIX then strips one
  matching quote pair per token) and the same step-order/skip-if-
  unconfigured/stop-on-first-failure/gate.finished-event semantics.
- `profile.ts`: `crewbench_profile.py`'s Node/Python/Go/Make detection and
  `agy_rules_for_commands()` ported field-for-field, tested against the
  same scenarios `test_profile.py` covers (plus a Makefile-detection case
  the Python suite doesn't have, since it's genuinely untested there too).
- `git.ts`: `git_state()`/`git_changes()` ported field-for-field --
  **every** warning condition (branch switch, HEAD move, stash change,
  reverted/deleted uncommitted files, a read-only reviewer touching
  anything, a tester touching non-test files, push-vs-fetch
  disambiguation) has its own test, ported directly from
  `test_git_safety.py`'s real-git-repo scenarios (including the
  two-remotes push/fetch distinction test, the most elaborate one in that
  file).
- `worktree.ts`: the **mechanical** half of `lib/dispatch.md` §5's
  worktree pre-flight/commit/cleanup -- `createWorktree()`,
  `runSetupCommands()`, `copyWorkspaceFiles()`, `commitAll()`,
  `integrate()` (merge/cherry-pick/leave/none), `removeWorktree()`,
  `pruneWorktrees()`, plus `snapshotRef()`/`deltaDiff()` for §6's
  per-round delta diff. Deliberately **not** included: the interactive
  "ask the user" half (dirty-tree decision, setup/copy confirmation,
  commit message, integrate choice, push confirmation) -- those are
  milestone 5's approval-flow territory; this milestone only builds the
  git primitives a later approval handler calls once a decision exists.
  `commitAll()`'s docstring says explicitly that nothing in this engine
  calls it without an external approval already having happened, per
  `docs/app/CONTEXT.md`'s non-negotiable principle 3.
- `runner.ts`: `dispatchRole()` runs one role headlessly end to end --
  builds the prompt (via adapters' `buildPrompt`), resolves and spawns
  the real CLI process detached (its own process group), streams stdout
  through the adapter's `Stream`, writes the log incrementally, emits
  every event type from `docs/app/contract/events.md`, and writes the
  exact `runs/<role>-r<round>.*` file family plus `status.json` in the
  same locked, atomic way the Python side does. `dispatchVerification()`
  runs tester and code-reviewer in parallel (`Promise.all`, one wait, not
  two -- mirrors `lib/dispatch.md` §4 point 4). Collapses Python's
  detached start/wait split into one direct async call: that split
  exists in `crewbench_dispatch.py` to survive a *host LLM's own shell
  tool* possibly cutting off a background job, which doesn't apply here
  -- this runner is the long-running process itself, not something
  invoked through another tool's shell. `cancelRun()` is written but
  currently unreachable from `dispatchRole()`'s own single-call
  interface (no pid is exposed before the process exits) -- flagged
  in its docstring as a real gap for a future pid-exposing "start" split,
  not silently assumed solved.
- **Caught two real bugs via failing integration tests, not inspection**:
  (1) `runner.ts` initially never resolved the actual CLI executable path
  -- `buildCommand()` always emits the bare CLI name (`"claude"`) as
  `argv[0]`; Python's `main()` substitutes the real, override-aware path
  in *after* building the command (`cmd[0:1] =
  cli_argv_prefix(cli_path)`), a step I'd ported into `gate.ts`'s step
  runner but forgotten in the role-dispatch path. Every fake-CLI
  integration test silently ran the *real* `claude` binary instead of the
  fixture until this was fixed -- caught because the test asserted a
  specific fixture session id (`"quick-0001"`) that a real `claude`
  process could never produce. (2) `worktree.ts`'s `deltaDiff()` defaulted
  its second ref to `"HEAD"`, so `git diff <ref> HEAD` only ever compared
  two *commits* -- useless for the actual use case (diffing a previous
  round's snapshot against the *current, still-uncommitted* round's
  work). Fixed to omit the second ref by default, matching plain
  `git diff <ref>`'s working-tree-comparison behavior.
- Full verification: `pnpm -r typecheck/build/test` all green (227 TS
  tests: 25 contract + 107 adapters + 95 engine); the Python suite (212
  tests) unaffected and still green.

### Milestone 5 — done (2026-09-19)

- `approvals.ts`: `resolveApproval()` is the enforced backstop for
  `docs/app/CONTEXT.md`'s non-negotiable principle 3 — passing `auto: true`
  for `commit`/`push` always throws `AutoResolveForbiddenError`, regardless
  of the decision given. `run.ts` never passes `auto: true` for either
  kind (its `flags.yes` guard is written as `flags.yes ? false :
  await confirm(...)`, i.e. `--yes` explicitly does *not* skip the commit
  prompt), so the invariant holds structurally, not just by convention.
- `summary.ts`: `formatDuration()`/`formatRoleLine()`/`usageSummary()`
  reproduce `lib/dispatch.md` §7's example lines exactly (tested against
  the literal `developer · agy gemini-3.8-flash · 2 runs · 6m12s` /
  `total: 4 runs · 9m57s` example). `summarizeTask()` takes an injectable
  `LlmSummarizer` and always has `deterministicSummary()` as a fallback —
  tested for the no-callback, success, throw, and empty-string-reply
  cases, so "a task's outcome is never unreported over an LLM-call
  hiccup" is an actual tested property, not just a docstring claim.
- `chat.ts` (adapters) + `chat-runner.ts` (engine): a plain conversational
  turn per CLI (no role brief, no result schema), used by scoping and
  available to a future `LlmSummarizer` implementation. No Python
  precedent exists for this — flagged `VERIFY` in `chat.ts`'s docstring,
  since the exact flag set for a *non-role* conversational call wasn't
  separately re-verified against each CLI's live `--help` the way every
  role-dispatch flag was in Phase 0/milestone 2.
- `scoping.ts`: `startScoping()`/`continueScoping()` drive a session-
  resuming conversation ending in a schema-valid `TaskSpec`
  (`tryParseTaskSpec()` reuses the same extractJson-then-validate pattern
  a role dispatch's result parsing uses). Tested against a real fake-CLI
  subprocess (a small inline fixture script, not `tests/fixtures/`'s
  existing ones, since none of those simulate a multi-turn conversation)
  proving a real two-turn session-id-carrying round trip, not just that
  `tryParseTaskSpec()` parses canned text.
- `task-store.ts`: the TS counterpart of `crewbench_state.py`'s core
  operations (`createTask`/`setField`/`appendField`/`listTasks`), same
  `makeTaskId()` shape, same two-lock scheme as milestone 4's
  `contract-fs.ts`. This is what milestone 6's cross-compat tests (create
  with the app, read with the plugin, and back) will exercise directly.
- **New `packages/cli`** (the `crewbench` bin): `run` drives the actual
  engine loop end to end (scoping → lineup → worktree pre-flight →
  `reduce`/`decide` fix loop → gate → parallel verification → commit
  approval → integrate → cleanup → summary), `status`/`doctor`/`team
  show`/`profile show|refresh` are real; `resume` is an honest stub this
  milestone (reports last-known phase/round, states plainly that full
  event-replay resume is milestone 6 — not faked as working). Root-finding
  (`findRoot()`) and lineup resolution (`resolveLineup()`, the merge order
  from `lib/dispatch.md` §1) are new modules specific to this package.
- **Caught three real bugs before/while writing tests, not by inspection**:
  (1) `dispatchRole()` never validated a parsed `result` against the
  role's schema at all — Python's `problem = error or validate(result,
  schema)` step was missing entirely, so a malformed or wrong-role result
  was silently accepted as `ok: true`. Added `validateAgainstRoleSchema()`
  and a dedicated positive/negative regression test pair. (2)
  `lineup.ts`'s merge logic read `loop.maxRounds`/`fixThreshold`
  (camelCase) while the real `config/defaults.json`/`team.json` file
  format uses snake_case (`max_rounds`/`fix_threshold`) — a team.json
  override for `max_rounds` was silently ignored and the hardcoded
  default always won. Caught by a test that round-tripped a real-shaped
  team.json file, not by re-reading the code. (3) `run.ts`'s verification
  step only fell back to a safe default `TesterResult`/`ReviewerResult`
  when `result` was `null` — but a schema-validation failure (bug #1's
  fix) leaves `result` as the malformed object, not null, so casting it
  directly would crash `combinedFixList()`'s `tester.failures.map(...)`
  on `undefined`. Fixed to check `envelope.ok`, not `result`'s nullness,
  before the manual smoke run confirmed a 3-round fix loop completes
  cleanly instead of crashing.
- Manually ran the full `run` command against a real subprocess (piped
  stdin, `--yes`) before writing the automated end-to-end test, to see
  the actual failure shape first-hand (this is exactly how bug #3 above
  was found) — then captured that same scenario as
  `run.e2e.test.ts`: a real built binary, a real worktree, real dispatch
  against `tests/fixtures/fake_clis/quick_success.py`, asserting the
  fix loop runs 1 round to a clean `stopped` outcome (with
  `--rounds 1`) and that `state.json` on disk matches.
- Full verification: `pnpm -r typecheck/build/test` all green (280 TS
  tests: 25 contract + 107 adapters + 128 engine + 20 cli); the Python
  suite (212 tests) unaffected and still green.

(Milestones 6–7's notes appended here as each one completes.)
