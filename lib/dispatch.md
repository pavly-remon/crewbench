# crewbench: team lineup and dispatch protocol

Every crewbench skill follows this protocol whenever it hands work to a crew
role (`developer`, `tester`, `code-reviewer`, `ui-ux`). It works the same
whether the Team Lead is running in Claude Code, GitHub Copilot CLI,
Antigravity CLI (`agy`), or Codex CLI.

`<root>` below is the crewbench install directory (the one containing
`agents/`, `bin/`, `config/`, `lib/` and `schemas/`).

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

Used by `new-task`'s fix loop (see its skill and §5, "Diff-aware review and
the fix loop", below).

## 2. Align with the user

Before delegating anything, show the lineup for the roles this skill will
use as a compact table (role, CLI, model, effort, permissions) and ask whether to keep
it or change it. Accept plain-language changes — "reviewer on codex with
high effort", "everyone on opus", "developer on agy with gemini flash".

- If they say go / looks good, proceed.
- If they change something, confirm the new table, then ask once whether
  to save it as the project default. Only on yes, write the changed fields
  to `.crewbench/team.json` (create it; merge into it if it already
  exists; keep it minimal — only fields that differ from the defaults).
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
    --model <model> --effort <effort> --handoff <handoff-file> [--skip-permissions]
```

Add `--skip-permissions` only when the agreed lineup has `permissions: skip`
for that role.

1. Write the hand-off to `.crewbench/runs/<role>-<n>.md` (add
   `.crewbench/runs/` to `.git/info/exclude` if it isn't ignored). Include
   only the hand-off itself — task, acceptance criteria, files, diff, spec,
   previous role results — everything the native subagent would have
   received. The script assembles the full prompt (role brief from
   `<root>/agents/`, the role's limits, this hand-off, and the JSON result
   schema from `<root>/schemas/`) and writes it to
   `.crewbench/runs/<role>-<n>.prompt.md`. Claude and Codex read that full
   prompt from stdin; agy and Copilot don't support a prompt on stdin, so
   they instead get a short `-p`/`--prompt` telling them to read their
   complete instructions from that file's absolute path — this avoids
   `E2BIG` on large hand-offs (a full diff, prior rounds' results). You never
   need to build this split yourself; it's internal to the script.

2. Run the script from the project root in the background and wait for
   it (allow up to 30 minutes). Pass `--effort none` when the chosen model
   takes no effort setting. As soon as it starts, tell the user how to watch
   it, e.g.:

   > Developer is working on agy — watch it live with
   > `tail -f .crewbench/runs/developer-1.log`

   The log shows each tool the role uses (files read and edited, commands
   run) with timestamps. `.crewbench/runs/status.json` lists every run with
   its state (running / done / failed), pid, log file and session id — read
   it when the user asks what the crew is doing.

3. The script prints a JSON envelope and saves it to
   `.crewbench/runs/<role>-<n>.result.json`:

   ```json
   {
     "role": "developer", "cli": "agy", "model": "gemini-3.8-flash", "effort": "medium",
     "ok": true, "exit_code": 0, "duration_s": 41.2,
     "result": { "status": "done", "summary": "...", "files_changed": [], "assumptions": [], "questions": [], "blocked": [] },
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

4. When tester and code-reviewer run in parallel, start both before
   waiting on either (background shell jobs, or a native subagent call
   alongside a background job).

5. If `ok` is false, tell the user the `error` in plain words and ask
   whether to retry, switch that role's CLI, or stop. If `blocked` or
   `permission_denials` is non-empty, tell the user what the role couldn't
   do — never retry it with permission checks disabled.
   If `warnings` is non-empty (e.g. agy allow rules that can never match, or
   a role touching git history or files it shouldn't have), pass them on to
   the user once — don't change their settings yourself and don't undo
   anything on their behalf. `notes` (e.g. "remote-tracking refs updated
   (likely git fetch)") are informational only — no action needed.

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
needs its own confirmation. The script snapshots HEAD, branch, remote refs,
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

## 5. Diff-aware review and the fix loop

This applies to `new-task`'s tester/code-reviewer rounds (see its skill for
the overall flow); `test`, `review` and `design` don't loop.

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

## 6. Reporting

When summarizing results to the user, mention which CLI/model did the work
only when it isn't the default lineup, or when something failed.
