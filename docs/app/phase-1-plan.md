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

(Notes appended here after each milestone completes.)
