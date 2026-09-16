# crewbench: team lineup and dispatch protocol

Every crewbench skill follows this protocol whenever it hands work to a crew
role (`developer`, `tester`, `code-reviewer`, `ui-ux`). It works the same
whether the Team Lead is running in Claude Code, GitHub Copilot CLI,
Antigravity CLI (`agy`), or Codex CLI.

`<root>` below is the crewbench install directory (the one containing
`agents/`, `bin/`, `config/`, `lib/` and `schemas/`).

## Host detection and plugin root

Before anything else, know which CLI you (the Team Lead) are actually
running in — the dispatch route (§3) and the flags used against your own
`host` CLI both depend on it. Don't rely on your own sense of "which model
am I" — resolve it the same way every time:

- **`<root>`** — the placeholder in each skill's "Before you start" line
  (`${CLAUDE_PLUGIN_ROOT}`) is expanded by some hosts and not others. In
  order: (1) if it read as an actual path, not a literal placeholder, use it;
  (2) otherwise `<root>` is two directories above the `SKILL.md` file you are
  reading right now — every host that can invoke a skill at all gives you
  that file's own path in the process, so this always works; (3) as a last
  resort (e.g. you're reasoning about `<root>` before reading any skill,
  which shouldn't normally happen), the crewbench plugin cache is at
  `~/.claude/plugins/cache/*/crewbench/*` (Claude Code), `~/.codex/plugins/
  cache/*/crewbench/*` (Codex), `~/.gemini/config/plugins/crewbench` (agy),
  or `~/.copilot/installed-plugins/*/crewbench*` (Copilot — VERIFY, layout
  inferred from `copilot plugin --help`, not confirmed against a real
  install).
- **`host`** — run `python3 <root>/bin/crewbench_env.py whoami` once per
  task (cheap, no network). It prints `{"host": ..., "plugin_root": ...,
  "python": ..., "platform": ..., "config_dir": ...}`. `host` is `claude`
  when `CLAUDECODE=1` is set (confirmed live in Claude Code's own
  environment); otherwise it's read off your own process's ancestry looking
  for `codex`, `agy` or `copilot` (POSIX only — no reliable signal was found
  for any of the three on Windows, VERIFY). If it comes back `"unknown"`,
  ask the user once which CLI they're running crewbench from and record the
  answer as `state.json.host_override` (§0) — reuse it silently for the rest
  of the task and on `/crewbench:resume`, without asking again.

## 0. Task folder and state

Every `new-task`, `test`, `review` and `design` invocation gets a task
folder before anything else happens:

```
.crewbench/
  team.json            (unchanged, user-owned, committable)
  project.json         (Phase 7, committable)
  project.md           (Phase 7, committable)
  index.json           (auto-maintained — don't hand-edit)
  tasks/<task-id>/
    state.json
    runs/<role>-r<round>.md | .prompt.md | .log | .result.json | .raw.txt
  wt/<task-id>/        (Phase 5, worktrees — not created by in-place tasks)
```

1. Compute the task id: `python3 <root>/bin/crewbench_state.py slug "<task
   text>"` → `YYYYMMDD-HHMM-<up-to-5-word-kebab-slug>`.
2. Create the state file:
   `python3 <root>/bin/crewbench_state.py new --task-dir
   .crewbench/tasks/<task-id> --id <task-id> --command <new-task|test|review|design>
   --title "<short title>"`. This also upserts `.crewbench/index.json`.
3. Ensure `.crewbench/tasks/` and `.crewbench/wt/` are in
   `.git/info/exclude` (append them if missing; leave `team.json`,
   `project.json`, `project.md`, `index.json` out of that ignore list —
   they're meant to be committed).
4. Update `state.json` at every phase transition — `set --key phase
   --value "<phase>"` (see `schemas/task-state.json` for the enum), and
   `append --key rounds --value '{...}'` after each fix round. Round-aware
   headless dispatches use `--task-dir .crewbench/tasks/<task-id> --round
   <n>` (§4) instead of a bare `--handoff` path, so run artifacts land at
   `.crewbench/tasks/<task-id>/runs/<role>-r<n>.*`.
5. On a normal finish, set `phase` to `done`/`stopped`/`failed` as
   appropriate; on an unhandled error, still leave the state file in a
   sensible phase rather than abandoning it half-updated — `/crewbench:
   resume` and `/crewbench:status` read it as-is.

`test`, `review` and `design` use the same task folder and `state.json`
shape (a `command` of `test`/`review`/`design`) but never loop past one
round and stay `in-place` — no `base_commit`/`branch`/`worktree` fields to
maintain beyond what `review`'s own workflow already gathers (the branch
and base it's comparing).

### Project profile

Before the first hand-off of any task, make sure `.crewbench/project.json`
exists:

- If it does, read it (and `.crewbench/project.md`, if present) and include
  a short summary of both — package manager, configured `commands`,
  languages/frameworks, source dirs, and `project.md`'s conventions — in
  **every** role hand-off, so each role doesn't have to rediscover configs
  itself.
- If it doesn't, run `python3 <root>/bin/crewbench_profile.py detect --cwd .`,
  show the compact result to the user, and ask them to confirm or correct it
  once (this is the same flow `/crewbench:profile refresh` runs any time
  later). Only after they confirm, write `.crewbench/project.json` (fields
  per `schemas/project.json`) with `confirmed: true`. Never write it
  silently. If detection finds nothing (empty `languages`), that's a valid
  confirmed result too — don't loop asking.
- `project.json`'s `commands` (`lint`, `typecheck`, `test`, `test_changed`,
  `build`, `format_check`) feed `bin/crewbench_gate.py` (§6, "Deterministic
  gate") directly — the gate reads `project.json` itself, you don't pass its
  commands on the command line.
- `project.json`'s `agy_allow_rules` are suggestions only — show them (with
  `crewbench_profile.py agy-rules`) via `/crewbench:profile`, never write to
  `~/.gemini/antigravity-cli/settings.json` yourself.
- `project.md` is free-form prose (folder structure, state management,
  styling approach, testing conventions) that only the user or
  `/crewbench:profile edit` adds to — crewbench never invents conventions
  and writes them there on its own.

## 1. Build the lineup

A lineup entry has four fields per role:

| Field | Values |
|---|---|
| `cli` | `host` (the CLI you, the Team Lead, are running in), `claude`, `codex`, `agy`, `copilot` |
| `model` | `cheap` or `strong` (a tier, resolved per CLI below), or an exact model name/alias for that CLI |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| `permissions` | `safe` (sandboxed / scoped tools) or `skip` (permission checks skipped — see Safety). Ignored for `code-reviewer`, which is always read-only |

Merge, later wins:

1. `<root>/config/defaults.json` — the shipped defaults: developer and
   ui-ux on the `cheap` tier, tester and code-reviewer on the `strong` tier,
   everyone at `medium` effort, all on `host`; the developer runs with
   `permissions: skip`, everyone else `safe`.
2. `.crewbench/team.json` in the project root, if it exists — the project's
   saved lineup. Same shape as the defaults; may contain only some roles or
   fields, and may override `tiers`.
3. Anything the user tells you for this task.

Resolve `host` to the CLI you are actually running in, then resolve a tier
through `tiers[<cli>]`. An exact model name is passed through unchanged.

### Loop settings

Also merged from the same three sources (same later-wins order), under a
`loop` key, one set for the whole task rather than per role:

| Field | Values |
|---|---|
| `max_rounds` | Maximum fix rounds before stopping and reporting stuck (default `3`) |
| `fix_threshold` | Minimum reviewer severity that triggers another fix round: `blocker` \| `major` \| `minor` (default `major`; `blocker` > `major` > `minor`) |

Used by `new-task`'s fix loop (see its skill and §6, "Diff-aware review and
the fix loop", below).

### Workspace settings

Also merged the same way, under a `workspace` key:

| Field | Values |
|---|---|
| `mode` | `worktree` (default — `new-task` isolates the task in `git worktree add .crewbench/wt/<task-id>`) or `in-place` (work directly in the current checkout, pre-Phase-5 behavior) |
| `setup` | Shell commands to run once in a fresh worktree before delegating (e.g. `["npm ci"]`); empty by default |
| `copy` | Ignored files to offer copying from the main tree into a fresh worktree (default `[".env", ".env.local"]`) |

Used by `new-task`'s pre-flight (§5, "Worktree isolation", below). `test`, `review` and `design`
always stay `in-place` regardless of this setting — they don't change code.

### Lineup-confirmation setting

Also merged the same way, under a `confirm_lineup` key:

| Value | Behavior |
|---|---|
| `always` | Always ask (§2) before delegating, even if `.crewbench/team.json` exists. |
| `when_unsaved` (default) | Ask only when there's no saved lineup (`.crewbench/team.json` doesn't exist) or the user is actively requesting a change this turn. If a saved lineup exists and nothing's changing, just show the table and proceed. |
| `never` | Never ask — always just show the table and proceed, even with no saved lineup. |

`--yes` (below) forces `never`-style behavior for that one invocation,
regardless of the configured value — it does not change the setting itself.

### Flags in $ARGUMENTS

Every skill's `$ARGUMENTS` may carry flags ahead of or mixed into the free
text. Strip a flag (and, where noted, its value token) out of the text
before treating what's left as the task/scenario/description/branch name —
an unrecognized `--something` is left alone, since it's probably part of
the text itself (e.g. a shell flag the task description happens to
mention), not a crewbench flag.

| Flag | Skills | Effect |
|---|---|---|
| `--yes` | all | Force `confirm_lineup: never` for this invocation (see above); in `new-task`, also skip the UI/UX question and assume no design unless `--design` is also given. Never skips a commit or push confirmation — see "Commits" below. |
| `--design` | `new-task` | Use the ui-ux role for this task without asking. |
| `--in-place` | `new-task` | Force `workspace.mode: in-place` for this task only. |
| `--rounds N` | `new-task` | Override `loop.max_rounds` for this task only (`N` a positive integer). |
| `--dev <cli[:model]>` | `new-task` | Override the developer role's `cli` (and `model`, if given) for this task only. |
| `--review <cli[:model]>` | `new-task` | Same, for `code-reviewer`. |

These are exactly the third merge tier from §1 ("anything the user tells
you for this task") expressed as flags instead of a live answer — apply
them the same way you'd apply the equivalent spoken instruction, and don't
ask about them again. They only affect this one invocation: nothing here
gets written to `.crewbench/team.json` unless the user separately says to
save it (§2).

## 2. Align with the user

Before delegating anything, show the lineup for the roles this skill will
use as a compact table (role, CLI, model, effort, permissions), plus any
non-default `loop`/`workspace` settings that apply, on one or two lines
below it.

Whether you also ask, or just show the table and proceed, follows
`confirm_lineup` above (as overridden by `--yes` for this one call):

- `always`, or `when_unsaved` with no saved `.crewbench/team.json` yet:
  ask whether to keep the table or change it, in one single, compact
  message — don't split this into a lineup question and a separate
  question later if you can combine them (e.g. `new-task`'s own UI/UX
  question belongs in the same message when both apply).
- `when_unsaved` with a saved lineup and nothing changing this turn, or
  `never`: just show the table (and settings) and proceed without waiting
  for confirmation.
- Whenever a flag or the user's own request already pins a value (a named
  CLI/model, `--dev`, `--rounds`, etc.), don't ask about that value again —
  show it in the table as already decided.

Accept plain-language changes — "reviewer on codex with high effort",
"everyone on opus", "developer on agy with gemini flash", "stop after 5
rounds", "work in-place this time".

- If they say go / looks good, proceed.
- If they change something, confirm the new table, then ask once whether
  to save it as the project default. Only on yes, write the changed fields
  to `.crewbench/team.json` (create it; merge into it if it already
  exists; keep it minimal — only fields that differ from the defaults). A
  flag-driven, this-task-only override (above) is never offered for
  saving on its own — only an explicit spoken change is.
- Don't re-ask on later rounds of the same task (fix loops reuse the
  agreed lineup).

If the user named the lineup already in their request, skip the question
and just show the table you'll use.

## 3. Pick the dispatch route

For each role, after resolving:

**Native subagent** — use when the role's CLI is the host, the role is
`permissions: safe`, AND the host can honor the requested model and effort
natively (a `skip` role always uses the headless route):

- Claude Code: the `crewbench:crewbench-<role>` subagent (`ui-ux` →
  `crewbench:crewbench-ui-ux`). **Always pass the resolved `model` explicitly
  on the Agent call, regardless of the agent's frontmatter** — never rely on
  the frontmatter matching, since the two can drift. Effort can't be set per
  call — if the effort isn't `medium`, use the headless route with `claude`
  instead.
- Copilot CLI: the `crewbench-<role>` custom agent, only when Copilot's
  custom-agent invocation can be given a model per call (check
  `copilot --help` / `copilot help commands` for a per-agent or per-call
  model override — as of writing no such flag was found, so this branch is
  currently unreachable and Copilot always uses the headless route below;
  `VERIFY` if a future Copilot version adds one), **or** when the resolved
  `model` equals `tiers.copilot[<the role's default tier>]` (i.e. the
  Copilot-native tier default: `claude-sonnet-5` for developer/ui-ux,
  `claude-opus-5` for tester/code-reviewer) and the effort is `medium`.
  Otherwise use the headless route with `copilot`. Do not compare against the
  agent frontmatter's `model:` value (`sonnet`/`opus`) — those are Claude
  model names, not Copilot ones.
- Antigravity CLI and Codex CLI: always use the headless route (neither
  lets crewbench pin a subagent's model and effort, so they can only be
  guaranteed through a separate process).

**Headless CLI** — everything else. You run the dispatch script through
your shell tool (section 4); it starts the other CLI non-interactively.

**Worktree trade-off:** a native subagent shares your own process's working
directory — it has no independent cwd to point at the task's worktree. When
`workspace.mode` is `worktree` (§5), state the worktree's absolute path in
every native hand-off and instruct the role to work only inside it, but
treat this as best-effort: nothing stops it from touching a path outside
that tree. Headless dispatch's `--cwd <worktree>` (§4) is the reliable
isolation mechanism, since the child process's actual cwd is set to the
worktree. `/crewbench:team` should mention this trade-off when the lineup
mixes native and headless roles under `workspace.mode: worktree`.

### Per-host dispatch matrix

Every host CLI can hand any role to any of the four role-CLIs, including
back to its own CLI headlessly. Route and caveats, by host (rows) and role
CLI (columns) — "native" only ever applies on the diagonal (role CLI ==
host), and only when the rules above also allow it:

| Host \\ role CLI | claude | codex | agy | copilot |
|---|---|---|---|---|
| **Claude Code** | native subagent (model always passed explicitly), or headless if effort ≠ medium or `permissions: skip` | headless | headless | headless |
| **Codex** | headless | headless (own CLI, different session — pass `--ephemeral` per §4's "Same-CLI headless delegation" note) | headless | headless |
| **Copilot CLI** | headless | headless | headless | native custom agent only when Copilot can be given a model per call or the resolved model/effort match the tier default (currently unreachable — see above); otherwise headless |
| **agy** | headless | headless | headless (own CLI, different `--conversation`) | headless |

Every headless cell goes through §4's one dispatch script with `--cli
<role-cli>`; the flags it builds per CLI are in §4's Safety table and don't
change by host. Before dispatching to any **non-host** CLI, run `doctor` for
it once per task (see "Sandboxes and doctor" below) — a host's own shell
sandbox is the most common way a cross-CLI cell fails in practice (6.3), not
the dispatch script itself. When tester and code-reviewer run in parallel,
every host does it the same way: `start` both runs (§4), then one `wait`
call naming both — there's no per-host difference here, since `start`/`wait`
don't depend on your shell tool's own timeout or backgrounding behavior.

Real-CLI verification status per cell lives in
[`docs/compatibility.md`](../docs/compatibility.md), not here — this table
is the routing rule, that doc is the evidence.

### Native subagent hand-offs

Native and headless roles must return the same shape of result so mixed
lineups (some roles native, some headless) give you consistent data to
merge. Every role's brief already ends with a "Report format" section
telling it to end its answer with a single JSON object and nothing else —
but unlike the headless route, a native Agent call doesn't automatically
attach the concrete JSON Schema. So:

- Read `<root>/schemas/<role>.json` and include its exact contents in the
  hand-off you give the native subagent (e.g. "Your result must be a single
  JSON object matching this schema, with no text before or after it:" plus
  the schema JSON).
- After the subagent replies, parse the trailing JSON object from its
  answer the same way the dispatch script does: if the whole answer isn't
  valid JSON, look for the last fenced ```json block, and failing that, the
  last top-level `{...}` object in the text.
- If no valid JSON comes out of that, ask the same subagent once, in the
  same conversation, to restate its previous answer as a single JSON object
  matching the schema you gave it, with nothing else. If that still doesn't
  parse, treat the result as `{"...": ..., "ok": false}`-shaped for your own
  merging purposes — i.e. treat it as a failed/blocked round for that role
  and say so in your report, rather than guessing at its content.

## 4. Headless dispatch

Every headless hand-off goes through one script, whichever CLI you are and
whichever CLI the role runs on:

```
python3 <root>/bin/crewbench_dispatch.py --role <role> --cli <cli> \
    --model <model> --effort <effort> \
    --task-dir .crewbench/tasks/<task-id> --round <n> \
    --cwd <worktree-or-project-root> \
    --handoff <handoff-file> [--skip-permissions]
```

Add `--skip-permissions` only when the agreed lineup has `permissions: skip`
for that role. With `--task-dir`, every run artifact is named
`<task-dir>/runs/<role>-r<round>.*` regardless of what `--handoff` itself is
called, so nothing collides across rounds. `--cwd` is the child CLI's
working directory and the root the git safety snapshot (§1.3/Phase 1) runs
against — pass the task's worktree path when `workspace.mode` is
`worktree` (§5), otherwise the project root; it defaults to wherever you
run the script from if omitted.

1. Write the hand-off to `.crewbench/tasks/<task-id>/runs/<role>-r<round>.md`
   (§0 already put `.crewbench/tasks/` in `.git/info/exclude`). Include
   only the hand-off itself — task, acceptance criteria, files, diff, spec,
   previous role results — everything the native subagent would have
   received. The script assembles the full prompt (role brief from
   `<root>/agents/`, the role's limits, this hand-off, and the JSON result
   schema from `<root>/schemas/`) and writes it to
   `<role>-r<round>.prompt.md` next to it. Claude and Codex read that full
   prompt from stdin; agy and Copilot don't support a prompt on stdin, so
   they instead get a short `-p`/`--prompt` telling them to read their
   complete instructions from that file's absolute path — this avoids
   `E2BIG` on large hand-offs (a full diff, prior rounds' results). You never
   need to build this split yourself; it's internal to the script.

2. **Launch it detached, then poll — don't rely on your shell tool's own
   wait/background semantics.** Your host's shell tool may have a per-call
   time limit shorter than a role can take, and some hosts kill a
   background job the moment the tool call that started it returns
   (`VERIFY` per host — see `docs/compatibility.md`'s notes). The dispatch
   script's own `start`/`wait` subcommands sidestep this entirely, since the
   run keeps going in its own detached process group regardless of what your
   shell tool call does next:

   ```
   python3 <root>/bin/crewbench_dispatch.py start --role <role> --cli <cli> \
       --model <model> --effort <effort> \
       --task-dir .crewbench/tasks/<task-id> --round <n> \
       --cwd <worktree-or-project-root> \
       --handoff <handoff-file> [--skip-permissions]
   ```

   Returns immediately with `{"run": "<role>-r<round>", "pid": ..., "log_file": ...}`.
   Pass `--effort none` when the chosen model takes no effort setting. As
   soon as it starts, tell the user how to watch it, e.g.:

   > Developer is working on agy — watch it live with
   > `tail -f .crewbench/tasks/<task-id>/runs/developer-r1.log`

   Then poll with `wait`, choosing `--max-seconds` comfortably under your
   own host's shell-tool timeout (e.g. 240s) and calling it again if it
   comes back `"all_finished": false`:

   ```
   python3 <root>/bin/crewbench_dispatch.py wait \
       --task-dir .crewbench/tasks/<task-id> \
       --run <role>-r<round> [--run <role2>-r<round>] \
       --max-seconds 240
   ```

   Prints `{"runs": {...status.json entries...}, "envelopes": {...finished
   runs' full envelopes...}, "all_finished": bool}`. If the user wants to
   abandon a run mid-flight, `crewbench_dispatch.py cancel --task-dir
   <task-dir> --run <role>-r<round>` kills its whole process group and marks
   it `failed`.

   `<task-dir>/runs/status.json` lists every run with its state (starting /
   running / done / failed), pid, log file and session id regardless of
   which of `start`/`wait` you last called — read it directly when the user
   asks what the crew is doing (`/crewbench:status` does this for the user
   directly). The foreground, single-call form (no `start`/`wait`/`cancel`
   subcommand — just the flags as shown at the top of this section) still
   works exactly as before, for hosts or scripts where blocking in place is
   fine; `start`+`wait` is the one that works everywhere.

3. The script prints a JSON envelope and saves it to
   `<task-dir>/runs/<role>-r<round>.result.json`:

   ```json
   {
     "role": "developer", "cli": "agy", "model": "gemini-3.8-flash", "effort": "medium",
     "ok": true, "exit_code": 0, "duration_s": 41.2,
     "result": { "status": "done", "summary": "...", "files_changed": [], "assumptions": [], "questions": [], "blocked": [] },
     "usage": { "duration_s": 41.2, "input_tokens": null, "output_tokens": null, "total_tokens": null, "cost_usd": null, "num_turns": null },
     "permission_denials": [], "error": null, "warnings": [], "notes": [],
     "session_id": "1c16c942-...", "resume_command": "agy --conversation 1c16c942-...",
     "result_file": "...", "log_file": "...", "raw_output_file": "..."
   }
   ```

   The whole run (including any agy denial-resumes) shares one deadline
   derived from `--timeout`; a resume only gets whatever time is left, so a
   role can't stack retries into several multiples of the timeout. On
   timeout, the script kills the CLI's entire process group/tree (not just
   the direct child — the CLIs spawn node/helper processes that would
   otherwise survive), and the run ends `failed` with `error` describing the
   timeout.

   `session_id` and `resume_command` (e.g. `agy --conversation <id>`,
   `claude --resume <id>`) let the user open the role's full session once
   it has finished — mention them when reporting a role's result, and never
   suggest opening a session that is still running.

   `result` follows `<root>/schemas/<role>.json`:
   - developer: `status` (done / blocked / needs_clarification), `summary`,
     `files_changed`, `assumptions`, `questions`, `blocked`
   - tester: `verdict` (pass / fail / error), `summary`, `tests_run`,
     `tests_added`, `failures[]` (test, file, expected, actual, reason),
     `blocked`
   - code-reviewer: `verdict` (approve / changes_requested), `summary`,
     `issues[]` (id, file, line, severity, category, change),
     `previous_issues[]` (id, status: resolved/still_present, note — only
     from round 2 on), `blocked`
   - ui-ux: `status`, `summary`, `spec_markdown`, `reused_components`,
     `questions`, `blocked`

   Use these fields directly: merge tester `failures` and reviewer `issues`
   into the developer's fix list, and pass earlier results along verbatim
   in later hand-offs so roles on different CLIs share the same facts.

4. When tester and code-reviewer run in parallel: `start` both (or `start`
   one and dispatch the other as a native subagent, in a mixed lineup)
   before your first `wait` call, then `wait` naming both runs at once — one
   call, not one per run.

5. If `ok` is false, tell the user the `error` in plain words and ask
   whether to retry, switch that role's CLI, or stop. If `blocked` or
   `permission_denials` is non-empty, tell the user what the role couldn't
   do — never retry it with permission checks disabled.
   If `warnings` is non-empty (e.g. agy allow rules that can never match, or
   a role touching git history or files it shouldn't have), pass them on to
   the user once — don't change their settings yourself and don't undo
   anything on their behalf. `notes` (e.g. "remote-tracking refs updated
   (likely git fetch)") are informational only — no action needed.

### Usage and timing

`usage` records whatever timing/token/cost data that run's CLI actually
exposed — `duration_s` (wall-clock, same value as the envelope's top-level
`duration_s`) is always present; `input_tokens`, `output_tokens`,
`total_tokens`, `cost_usd` and `num_turns` are `null` whenever that CLI or
run didn't report them. A run's `ok`/`error` never depends on `usage` being
complete — missing usage is not a failure.

Confirmed shape: claude's `--output-format stream-json` terminal `result`
event's documented `usage`/`total_cost_usd`/`num_turns` fields. `VERIFY`
(best-effort, not confirmed live for this feature): agy's equivalent
`usage` sub-object field names, and a plain text scan of codex/copilot's
stdout for a "tokens used" style line — neither CLI's headless output is
documented to expose usage as of writing, so both commonly stay `null` in
practice.

After each run finishes, fold its `usage` into `state.json.usage.<role>`
(§0's field reference) — `get` the current value, add to it, `set` it
back:

- `runs`: increment by 1.
- `duration_s`: add this run's `usage.duration_s`.
- `tokens`: add this run's `usage.total_tokens` (or `input_tokens` +
  `output_tokens` when only those are known); leave `null` if this role
  has never reported any tokens yet, don't treat a null run as a zero.
- `cost_usd`: same addition rule as `tokens`.
- `cli` / `model`: overwrite with this run's values (the summary line only
  needs the latest, not a history).

Do this after every run, not just at the end, so a stopped or failed task
still has a partial usage summary for `/crewbench:status`.

### Safety

With `permissions: safe`, child agents run sandboxed or with a scoped tool
set:

| CLI | developer / tester | code-reviewer | ui-ux |
|---|---|---|---|
| claude | `--permission-mode auto` (each action reviewed), scoped `--tools` | `--permission-mode plan`, read tools only | `auto`, no shell |
| codex | `-s workspace-write` sandbox | `-s read-only` | `-s workspace-write` |
| agy | `--sandbox --add-dir <project> --mode accept-edits`; project reads/edits run, shell commands only if in your agy `permissions.allow` | `--sandbox --mode plan` | `--sandbox --mode accept-edits` |
| copilot | file edits only; shell and URLs denied | read only | file edits only |

With `permissions: skip` (`--skip-permissions`), the role runs unattended:

| CLI | Flags |
|---|---|
| claude | `--permission-mode bypassPermissions` |
| agy | `--dangerously-skip-permissions`, still `--sandbox` |
| codex | `-s danger-full-access` |
| copilot | `--allow-all-tools` |

### Commits

No crew role commits or pushes — their briefs and limits say so. Only the
Team Lead commits, and only after the user explicitly confirms; pushing
needs its own confirmation. **Neither confirmation is ever skippable** —
not by `confirm_lineup: never`, not by `--yes`, not by anything else in
"Flags in $ARGUMENTS" (§1). Those only shortcut the lineup/design
questions; the commit and push steps always stop and wait for an explicit
answer. The script snapshots HEAD, branch, remote refs,
the stash list, and a content hash of every dirty (modified/added/untracked)
path before and after each run, and adds a `warnings` entry if a role:

- moved HEAD, switched branch, or changed the stash list (`git stash`);
- reverted or deleted files that were uncommitted before the run started —
  this is the key signal in fix rounds, where "dirty before" is the
  developer's own earlier, still-unapproved work (e.g. a rogue
  `git checkout -- .` or `git reset --hard` would otherwise wipe it
  silently);
- is `code-reviewer` and the working tree changed at all (it must stay
  read-only);
- is `tester` and changed a file that doesn't look like a test (path
  doesn't contain `test`/`tests`/`__tests__`/`spec`/`e2e` and isn't
  `*.test.*`/`*.spec.*`).

A remote-tracking-ref change that isn't accompanied by local history moving
is reported as an informational `notes` entry ("likely git fetch"), not a
warning — harmless fetches shouldn't look like a "push or fetch" scare. Where
the upstream ref can be resolved, an actual push is called out by name
instead. This is all report-only: the script never undoes anything — tell
the user and let them decide.

Only use `--skip-permissions` when the lineup says so; never add skip flags
any other way, and never edit a CLI's permission settings to get a role
unblocked — report it to the user instead. If your own CLI refuses to
launch a `skip` run (e.g. Claude Code's auto mode blocks it), tell the user
it was blocked and ask whether to approve it themselves or switch that role
to `safe`; don't try to get around the block.

### `skip` launch friction on a Claude Code host

When you (the Team Lead) are running as `claude`, every headless
`crewbench_dispatch.py` call (§4) goes through your own Bash tool, which by
default asks the user to approve it every single time unless their
`~/.claude/settings.json` already allow-lists it — pure ceremony once
they've approved it once. Check for this proactively instead of letting
them discover it by being asked over and over:

- Read `~/.claude/settings.json` (a plain file read, not a dispatch) and
  look in `permissions.allow` for an entry that already covers `python3
  <root>/bin/crewbench_dispatch.py ...` invocations, e.g. `Bash(python3
  */crewbench_dispatch.py *)` or a broader one like `Bash(python3 *)`
  (`VERIFY`: the exact glob semantics of Claude's `Bash(...)` allow-rule
  syntax weren't re-derived from a live example on this machine — match
  loosely against this pattern, don't require an exact string).
- If nothing matches, tell the user once — in `/crewbench:team`, and the
  first time any other skill is about to make its first dispatch call this
  session — that every headless dispatch will otherwise prompt for
  approval, and show the exact line to add themselves: `Bash(python3
  */crewbench_dispatch.py *)`. **Never edit the file yourself** — only
  show it.
- Check this once per session (remember the answer for the rest of the
  conversation), not once per round or per dispatch call. Meaningless on
  any other host — only Claude Code's Bash-tool approval flow works this
  way.

### Sandboxes and doctor

Your own shell tool may itself be sandboxed (Codex `workspace-write`
normally blocks outbound network; agy `--sandbox`; Copilot's tool approvals;
Claude Code's auto mode), and a role CLI started from inside that sandbox
inherits it — it can end up with no network (can't reach its model API), no
write access to its own config/auth directory (`~/.claude`, `~/.codex`,
`~/.gemini`, `~/.copilot`), or blocked process spawning. This is the most
common reason a cross-CLI cell in the dispatch matrix (§3) fails in
practice, and it looks like a confusing dispatch-script error unless you
check for it first.

Before the **first** dispatch to each **non-host** CLI in the agreed lineup
for a task, run:

```
python3 <root>/bin/crewbench_dispatch.py doctor --cli <cli>
```

Prints `{"cli", "installed", "version", "config_dir", "config_dir_writable",
"network_ok", "network_detail", "logged_in", "auth_detail", "ok", "errors":
[...]}` and exits 0 only when everything checked out. Cache the result in
`state.json.doctor.<cli>` (§0) for the rest of the task's session — don't
re-run `doctor` every round. If `ok` is false, tell the user the specific
`errors` (e.g. `"host sandbox blocks network — the codex child can't reach
its API"`) and what to change (run the host with network access for this
session, log in outside the sandbox, approve the command manually) instead
of failing mid-task with a raw exit-code error. Never change your own or
another CLI's sandbox or permission settings yourself.

`doctor`'s auth check uses the cheapest non-interactive status command each
CLI offers: `claude auth status --json`, `codex login status` (both
confirmed). agy has no dedicated status command, so it falls back to `agy
models` (a real, small network+auth call); copilot has none either, so it
falls back to checking for a stored credential or token env var, which is
weaker evidence than an actual call (`VERIFY` if either CLI adds a real
status command). If `crewbench_dispatch.py`'s own envelope `error` for a
regular dispatch (not `doctor`) matches a network, `EACCES`, or
not-logged-in signature, it already says so in plain words instead of just
the exit code — pass that along verbatim rather than re-diagnosing it
yourself.

### Nested-agent hygiene

The CLI you dispatch a role to may well have crewbench installed too — a
role must never treat that as an invitation to delegate further:

- **Recursion guard.** The dispatch script sets `CREWBENCH_ROLE=<role>` and
  `CREWBENCH_TASK=<task-id>` in every headless child's environment (this is
  automatic — you don't set these yourself), and refuses to run at all if
  `CREWBENCH_ROLE` is already set in its own environment. A role's brief and
  limits already say it must never invoke crewbench skills or dispatch other
  agents; this is the enforced backstop for that rule on the headless path.
  For a **native** subagent hand-off, say the same thing explicitly in the
  hand-off text, since there's no environment variable to enforce it there.
  Where a CLI can disable its own plugins/skills for one run, the dispatch
  script uses it for extra safety: Claude gets `--strict-mcp-config`
  (MCP only) plus its scoped `--tools` (already effectively blocking skill
  invocation); `VERIFY` — no equivalent "disable plugins for this run" flag
  was confirmed for codex, agy or copilot's headless mode as of writing, so
  the recursion guard above is their only enforcement.
- **Host environment leakage.** Each host CLI sets its own environment
  markers (confirmed: Claude Code sets `CLAUDECODE=1` and `CLAUDE_CODE_*`).
  A nested CLI inheriting a *different* host's markers could misbehave —
  the dispatch script strips every other host's known marker prefixes from
  a headless child's environment before launch, keeping only the target
  CLI's own (see `HOST_ENV_PREFIXES` in `bin/crewbench_dispatch.py` for the
  exact list, which is deliberately conservative and may not be
  exhaustive — `VERIFY` if a host adds new markers).
- **Same-CLI headless delegation** (e.g. a codex host dispatching a codex
  developer at a different effort). The dispatch script doesn't add any
  extra isolation beyond the env stripping above — codex's `--ephemeral`
  flag (skip persisting session files) and `-p/--profile` (layer a separate
  config) are available if a nested codex session collides with the host's
  own session state; add them to the lineup's notes if you hit this in
  practice (`VERIFY`, not wired into the script by default).
- **Auth isolation.** Never copy, read or print a CLI's credential files —
  the child always uses the user's own normal login for that CLI, found via
  its own config directory (unchanged, never redirected).

## 5. Worktree isolation (new-task only)

This is the default for `new-task` (`workspace.mode: worktree`, §1). `test`,
`review` and `design` always stay `in-place` — they never touch code.

### Pre-flight, after scoping and before implementation

1. Record `base_commit` (`git rev-parse HEAD`) and the current branch, and
   save both to `state.json` (§0).
2. If `workspace.mode` is `in-place`, skip straight to delegating — there's
   no worktree to set up, and the git safety checks (Phase 1) run against
   the current checkout as before.
3. Otherwise, check whether the main tree is dirty (`git status
   --porcelain`). If it is, tell the user which files are dirty and ask:
   continue anyway (the worktree starts from `base_commit` HEAD and will
   **not** include those uncommitted changes), commit/stash them
   themselves first, or use `in-place` for this task instead. Never stash
   or commit on the user's behalf.
4. Create the worktree: `git worktree add .crewbench/wt/<task-id> -b
   crew/<task-id> <base_commit>`. Save the worktree's absolute path to
   `state.json.worktree` and the branch name to `state.json.branch`.
5. **Environment setup** — a fresh worktree has no `node_modules`, no
   `.env*`, no build caches, so a frontend (or similar) project will break
   without this step:
   - Run `workspace.setup`'s commands, if any are configured, inside the
     worktree.
   - Otherwise, if `project.json` (§0's "Project profile") has an install
     command, ask the user once whether to run it and offer to save it into
     `workspace.setup` for next time.
   - Offer to copy files matching `workspace.copy` from the main tree into
     the worktree — list which files exist first, and only copy on yes.
     Never copy anything without that confirmation; these are often
     secrets.

### Running roles against the worktree

- Headless dispatch: pass `--cwd <worktree-absolute-path>` (§4) on every
  call for this task. This also means the git safety snapshot (Phase 1)
  runs against the worktree, not the main checkout.
- Native subagents: state the worktree's absolute path in the hand-off and
  instruct the role to work only inside it (see §3's "Worktree trade-off"
  note — this is best-effort, not enforced).

### Commit step (replaces the plain in-place commit step)

After the loop finishes and the user approves the work:

1. Show `git -C <worktree> status` and `git -C <worktree> diff --stat
   <base_commit>`, propose a commit message, and only on an explicit yes
   commit **on the worktree's branch** (`crew/<task-id>`).
2. If the original branch has moved since `base_commit`, say so before
   offering to merge.
3. Ask how to bring the work back, and only act on an explicit choice:
   - **Merge** `crew/<task-id>` into the original branch.
   - **Cherry-pick** the commit onto the original branch.
   - **Leave the branch** as-is, for a PR later.
   - **Do nothing yet.**
4. Push only on a separate, explicit yes — same as the in-place flow.

### Cleanup

Once the work is merged/cherry-picked, or the task is stopped, ask whether
to remove the worktree (`git worktree remove .crewbench/wt/<task-id>`) and
delete `crew/<task-id>`. `/crewbench:status --cleanup` finds finished tasks
with a leftover worktree and offers this per task; it also runs `git
worktree prune` for any worktree directories someone deleted by hand.

### `in-place` mode

Keeps the pre-Phase-5 behavior exactly, including the Phase 1 git safety
warnings — the difference is only that `workspace.mode` made it an
explicit choice instead of the only option.

`review` may optionally create a detached worktree for the branch under
review so the reviewer can read files from disk instead of relying on
`git show` output — offer this, don't default to it, since `review` is
meant to stay lightweight and read-only against the current checkout.

## 6. Diff-aware review and the fix loop

This applies to `new-task`'s tester/code-reviewer rounds (see its skill for
the overall flow); `test`, `review` and `design` don't loop.

### Deterministic gate (before the LLM tester)

Once the developer reports done for a round, run the gate before dispatching
the tester and code-reviewer:

```
python3 <root>/bin/crewbench_gate.py --cwd <worktree-or-project-root> \
    --task-dir .crewbench/tasks/<task-id> --round <n>
```

It reads `.crewbench/project.json`'s `commands` itself (no need to pass
them) and runs, in order, whichever of `format_check`, `lint`, `typecheck`,
`test_changed` (or `test` if `test_changed` isn't configured) has a command
configured — skipping any that don't. It stops at the first failing step.
Output is captured to `<task-dir>/runs/gate-r<n>.log`; the JSON result
(`{"ok": bool, "steps": [{"name", "command", "exit_code", "duration_s",
"timed_out", "output_tail"}, ...]}`) is also written to
`<task-dir>/runs/gate-r<n>.result.json` and printed on stdout. It runs
synchronously under your own shell tool (it's a deterministic check, not an
LLM role — no `start`/`wait` needed), and only ever runs commands the user
already confirmed into `project.json`.

- **If the gate fails** (`ok: false`): send the failing step's
  `output_tail` straight back to the developer as this round's fix list —
  don't dispatch the tester or code-reviewer this round. This still counts
  as a round toward `loop.max_rounds`. Record the gate result under this
  round's entry in `state.json.rounds[]` (a `gate` field alongside `runs`).
- **If the gate passes, or nothing is configured** (`steps: []`): proceed to
  the tester and code-reviewer below. Tell the tester which gate steps
  already passed (e.g. "lint and typecheck already passed — focus on
  acceptance criteria and new tests, not re-running the whole suite").

### Round 1: always give the reviewer a diff

Pass the code-reviewer: the task and acceptance criteria, `git diff --stat`
and the full `git diff` of the task's changes against the base commit (the
commit HEAD was at before the developer started — remember it for the
task; once Phase 4's task state exists, it's `state.json.base_commit`), and
the developer's `files_changed`. Tell it this is round 1.

### Round ≥ 2: previous issues + the delta

In addition to the round-1 inputs, pass the code-reviewer:

- The previous round's `issues[]` verbatim.
- The delta diff — what changed since the previous round only (save a
  diff or a `git stash create` snapshot's hash per round so you can produce
  this; once Phase 4 exists, store it in `state.json.rounds[]`).

Tell it which round this is (so it can number new issues `R<round>-<n>`)
and ask for `previous_issues[]`: `resolved` or `still_present` for each
prior issue.

Do the same for the tester: pass its previous round's `failures[]` and ask
it to rerun those first before checking anything new.

### Severity threshold

Only send the developer back for another round if either is true:
- The tester's `verdict` is not `pass` (any `failures[]`), or
- The reviewer has an `issues[]` (or `previous_issues[]` still
  `still_present`) entry at or above `loop.fix_threshold` (`blocker` >
  `major` > `minor`).

Issues below the threshold are never sent back — list them in the final
report as "optional follow-ups" instead.

### Stopping the loop

- Cap rounds at `loop.max_rounds`. If still failing at the cap, stop and
  report exactly what's stuck, per the oscillation rule below.
- **Oscillation:** if the same issue — same `file` and `category`, marked
  `still_present` for two consecutive rounds — or the same failing test
  (same `test` + `file`) fails two rounds in a row, stop early even if
  under `max_rounds`. Report it as stuck: the exact item, and what the
  developer already tried against it.

## 7. Reporting

When summarizing results to the user, mention which CLI/model did the work
only when it isn't the default lineup, or when something failed.

### Usage summary

End every final report (`new-task`, `test`, `review`, `design`) with one
compact line per role that actually ran, from `state.json.usage` (see §4's
"Usage and timing"), then a total:

```
developer · agy gemini-3.8-flash · 2 runs · 6m12s
tester · host (sonnet) · 1 run · 1m40s
code-reviewer · host (opus) · 1 run · 2m05s
total: 4 runs · 9m57s
```

Format `duration_s` as `MmSSs` (drop the minutes when under one). Append
` · $0.18`-style cost and/or ` · 18.2k tokens` after the duration only when
that role's aggregated `cost_usd`/`tokens` is known (not `null`) — omit
either or both when unknown, never print `$null` or a zero that was never
actually reported. Omit a role with zero runs entirely. This usage line is
the only place token/cost numbers appear — keep the plain-language summary
above it free of them.
