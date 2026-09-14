# crewbench: team lineup and dispatch protocol

Every crewbench skill follows this protocol whenever it hands work to a crew
role (`developer`, `tester`, `code-reviewer`, `ui-ux`). It works the same
whether the Team Lead is running in Claude Code, GitHub Copilot CLI, Gemini
CLI, or Codex CLI.

`<root>` below is the crewbench install directory (the one containing
`config/`, `crew/` and `lib/`).

## 1. Build the lineup

A lineup entry has three fields per role:

| Field | Values |
|---|---|
| `cli` | `host` (the CLI you, the Team Lead, are running in), `claude`, `codex`, `gemini`, `copilot` |
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
high effort", "everyone on opus", "developer uses gemini flash".

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
- Gemini CLI and Codex CLI: always use the headless route (crewbench does
  not install native subagents there, so model and effort can only be
  guaranteed through a separate process).

**Headless CLI** — everything else. You run another CLI non-interactively
through your shell tool.

## 4. Headless dispatch

1. Check the CLI exists: `command -v <cli>`. If it doesn't, tell the user
   and ask whether to run that role on the host instead. Never silently
   swap.

2. Write the hand-off prompt to a temp file (e.g.
   `.crewbench/runs/<role>-<n>.md`; add `.crewbench/runs/` to
   `.git/info/exclude` if it isn't ignored). Contents, in order:
   - The role brief: the body of `<root>/crew/<file>.md` with the YAML
     frontmatter stripped (`developer.md`, `tester.md`, `code-reviewer.md`,
     `ui-ux-designer.md`).
   - The role's tool limits in words (e.g. "You are read-only: do not edit
     files or run commands that change anything.").
   - The hand-off itself: task, acceptance criteria, files, diff, spec —
     everything the native subagent would have received.
   - "You are running non-interactively. Don't ask questions; if something
     is ambiguous, state it in your report. End with the report format your
     brief describes."

3. Run it from the project root, capturing output to
   `.crewbench/runs/<role>-<n>.out`. Use a long timeout (up to 30 minutes)
   or run in the background and wait for it:

   | CLI | Command |
   |---|---|
   | claude | `claude -p --model <model> --effort <effort> --allowedTools "<tools>" --permission-mode <mode> < <prompt>` |
   | codex | `codex exec -m <model> -c model_reasoning_effort=<effort> -s <sandbox> - < <prompt>` |
   | gemini | `gemini -m <model> --approval-mode <mode> -p "$(cat <prompt>)"` |
   | copilot | `copilot -s --no-ask-user --model <model> --effort <effort> --allow-all-tools <denies> -p "$(cat <prompt>)"` |

   Per-role permissions:

   | Role | claude `--allowedTools` / `--permission-mode` | codex `-s` | gemini `--approval-mode` | copilot `<denies>` |
   |---|---|---|---|---|
   | developer | `Read Write Edit Bash Grep Glob` / `acceptEdits` | `workspace-write` | `yolo` | — |
   | tester | `Read Bash Grep Glob` / `acceptEdits` | `workspace-write` | `yolo` | — |
   | code-reviewer | `Read Grep Glob` / `default` | `read-only` | `default` | `--deny-tool=write --deny-tool=shell` |
   | ui-ux | `Read Write Edit Grep Glob` / `acceptEdits` | `workspace-write` | `auto_edit` | `--deny-tool=shell` |

   Gemini CLI has no effort flag: pass the model only and tell the user the
   effort setting doesn't apply there. If a CLI rejects a model name or
   effort level, report the exact error and ask the user what to use —
   don't guess a replacement.

4. When tester and code-reviewer run in parallel and either is headless,
   start both before waiting on either (background shell jobs, or a native
   subagent call alongside a background shell job).

5. Read the `.out` file and treat it exactly like a native subagent's
   report. If the process failed or produced no report, say so plainly and
   ask whether to retry, switch that role's CLI, or stop.

## 5. Reporting

When summarizing results to the user, mention which CLI/model did the work
only when it isn't the default lineup, or when something failed.
