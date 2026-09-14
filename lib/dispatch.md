# crewbench: team lineup and dispatch protocol

Every crewbench skill follows this protocol whenever it hands work to a crew
role (`developer`, `tester`, `code-reviewer`, `ui-ux`). It works the same
whether the Team Lead is running in Claude Code, GitHub Copilot CLI,
Antigravity CLI (`agy`), or Codex CLI.

`<root>` below is the crewbench install directory (the one containing
`agents/`, `bin/`, `config/`, `lib/` and `schemas/`).

## 1. Build the lineup

A lineup entry has three fields per role:

| Field | Values |
|---|---|
| `cli` | `host` (the CLI you, the Team Lead, are running in), `claude`, `codex`, `agy`, `copilot` |
| `model` | `cheap` or `strong` (a tier, resolved per CLI below), or an exact model name/alias for that CLI |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` |

Merge, later wins:

1. `<root>/config/defaults.json` — the shipped defaults: developer and
   ui-ux on the `cheap` tier, tester and code-reviewer on the `strong` tier,
   everyone at `medium` effort, all on `host`.
2. `.crewbench/team.json` in the project root, if it exists — the project's
   saved lineup. Same shape as the defaults; may contain only some roles or
   fields, and may override `tiers`.
3. Anything the user tells you for this task.

Resolve `host` to the CLI you are actually running in, then resolve a tier
through `tiers[<cli>]`. An exact model name is passed through unchanged.

## 2. Align with the user

Before delegating anything, show the lineup for the roles this skill will
use as a compact table (role, CLI, model, effort) and ask whether to keep
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

**Native subagent** — use when the role's CLI is the host AND the host can
honor the requested model and effort natively:

- Claude Code: the `crewbench:crewbench-<role>` subagent (`ui-ux` →
  `crewbench:crewbench-ui-ux`). Pass `model` on the Agent call when it
  differs from the agent's frontmatter (developer/ui-ux: `sonnet`,
  tester/code-reviewer: `opus`). Effort can't be set per call — if the
  effort isn't `medium`, use the headless route with `claude` instead.
- Copilot CLI: the `crewbench-<role>` custom agent, only when model and
  effort equal the frontmatter defaults; otherwise go headless with
  `copilot`.
- Antigravity CLI and Codex CLI: always use the headless route (neither
  lets crewbench pin a subagent's model and effort, so they can only be
  guaranteed through a separate process).

**Headless CLI** — everything else. You run the dispatch script through
your shell tool (section 4); it starts the other CLI non-interactively.

## 4. Headless dispatch

Every headless hand-off goes through one script, whichever CLI you are and
whichever CLI the role runs on:

```
python3 <root>/bin/crewbench_dispatch.py --role <role> --cli <cli> \
    --model <model> --effort <effort> --handoff <handoff-file>
```

1. Write the hand-off to `.crewbench/runs/<role>-<n>.md` (add
   `.crewbench/runs/` to `.git/info/exclude` if it isn't ignored). Include
   only the hand-off itself — task, acceptance criteria, files, diff, spec,
   previous role results — everything the native subagent would have
   received. The script adds the role brief from `<root>/agents/`, the
   role's limits, and the JSON result schema from `<root>/schemas/`.

2. Run the script from the project root with a long timeout (up to 30
   minutes), or in the background and wait for it. Pass `--effort none` when
   the chosen model takes no effort setting.

3. The script prints a JSON envelope and saves it to
   `.crewbench/runs/<role>-<n>.result.json`:

   ```json
   {
     "role": "developer", "cli": "agy", "model": "gemini-3.8-flash", "effort": "medium",
     "ok": true, "exit_code": 0, "duration_s": 41.2,
     "result": { "status": "done", "summary": "...", "files_changed": [], "assumptions": [], "questions": [], "blocked": [] },
     "permission_denials": [], "error": null,
     "result_file": "...", "raw_output_file": "..."
   }
   ```

   `result` follows `<root>/schemas/<role>.json`:
   - developer: `status` (done / blocked / needs_clarification), `summary`,
     `files_changed`, `assumptions`, `questions`, `blocked`
   - tester: `verdict` (pass / fail / error), `summary`, `tests_run`,
     `tests_added`, `failures[]` (test, file, expected, actual, reason),
     `blocked`
   - code-reviewer: `verdict` (approve / changes_requested), `summary`,
     `issues[]` (file, line, severity, category, change), `blocked`
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

### Safety

Child agents never run with permission checks turned off. The script starts
each CLI sandboxed or with a scoped tool set:

| CLI | developer / tester | code-reviewer | ui-ux |
|---|---|---|---|
| claude | `--permission-mode auto` (each action reviewed), scoped `--tools` | `--permission-mode plan`, read tools only | `auto`, no shell |
| codex | `-s workspace-write` sandbox | `-s read-only` | `-s workspace-write` |
| agy | `--sandbox --mode accept-edits`; only actions allowed in your agy `permissions.allow` settings run | `--sandbox --mode plan` | `--sandbox --mode accept-edits` |
| copilot | file edits only; shell and URLs denied | read only | file edits only |

Never add `--dangerously-skip-permissions`, `bypassPermissions`,
`--allow-all-tools`, `--yolo` or similar flags, and never edit a CLI's
permission settings to get a role unblocked — report it to the user instead.

## 5. Reporting

When summarizing results to the user, mention which CLI/model did the work
only when it isn't the default lineup, or when something failed.
