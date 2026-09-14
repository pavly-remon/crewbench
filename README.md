# crewbench

A plugin for Claude Code, GitHub Copilot CLI, Antigravity CLI (`agy`) and
Codex CLI that runs a task through a five-role dev team: a Team Lead that scopes and
delegates, plus Developer, Tester, Code Reviewer, and (opt-in) UI/UX
Designer roles. Each role can run on its own CLI, model and reasoning
effort.

## Install

Claude Code:

```
/plugin marketplace add pavly-remon/crewbench
/plugin install crewbench@PiCode-marketplace
```

GitHub Copilot CLI:

```
copilot plugin marketplace add pavly-remon/crewbench
copilot plugin install crewbench@PiCode-marketplace
```

Antigravity CLI:

```
git clone https://github.com/pavly-remon/crewbench.git
agy plugin install ./crewbench
```

Codex CLI:

```
codex plugin marketplace add pavly-remon/crewbench
```

then install `crewbench` from the `PiCode` marketplace in `/plugins`.

## Commands

| Command | What it does |
|---|---|
| `/crewbench:new-task <task description>` | Full workflow: scope, (optional) design, implement, test + review, fix loop |
| `/crewbench:test <scenario>` | Tester writes and/or runs tests for one scenario and reports pass/fail |
| `/crewbench:review <branch> [base]` | Code reviewer reviews a branch's changes against `base` (default branch if omitted) |
| `/crewbench:design <description>` | UI/UX designer produces an implementable design spec |
| `/crewbench:team [change]` | Show or change the team lineup (CLI, model, effort per role) |

In Codex, invoke the skills by name (`$new-task`, `$test`, `$review`,
`$design`, `$team`).

`test`, `review`, and `design` only report — they never change your code. Each
offers to hand its results to `/crewbench:new-task` if you want something
fixed or built.

### new-task workflow

The Team Lead will:

1. Ask clarifying questions if the task is underspecified.
2. Offer a UI/UX spec if the task touches the UI (only runs if you say yes).
3. Show the team lineup and let you keep or change it.
4. Hand implementation to the developer.
5. Run the tester and code reviewer in parallel on the changed files.
6. Send one combined fix list back to the developer if either flags issues,
   up to 3 rounds.
7. Report back in plain language.

## Team lineup

Default lineup — cheaper model for building, stronger model for checking,
all at medium effort, all on the CLI you're running:

| Role | CLI | Model tier | Effort |
|---|---|---|---|
| developer | host | cheap | medium |
| tester | host | strong | medium |
| code-reviewer | host | strong | medium |
| ui-ux | host | cheap | medium |

Tiers resolve per CLI:

| CLI | cheap | strong |
|---|---|---|
| claude | `sonnet` | `opus` |
| codex | `gpt-5.6-terra` | `gpt-5.6-sol` |
| agy | `gemini-3.8-flash` | `gemini-3.1-pro` |
| copilot | `claude-sonnet-5` | `claude-opus-5` |

Before delegating, the Team Lead shows the lineup and asks whether to keep
it. Tell it what you want in plain language — "reviewer on codex with high
effort", "developer on agy with gemini flash", "everyone on opus" — and it
will use that for the task, and optionally save it to `.crewbench/team.json` in your
project:

```json
{
  "roles": {
    "code-reviewer": { "cli": "codex", "effort": "high" }
  },
  "tiers": {
    "codex": { "strong": "gpt-5.6-sol" }
  }
}
```

`cli` is `host`, `claude`, `codex`, `agy` or `copilot`; `model` is a
tier or an exact model name; `effort` is `low`–`max`. Defaults live in
[`config/defaults.json`](config/defaults.json).

### How roles are run

- **Native subagent** when the role stays on the host CLI and the host can
  apply the model and effort (Claude Code always for model; Copilot when
  using the defaults).
- **Headless CLI** otherwise, through `bin/crewbench_dispatch.py`. Any CLI
  can be the Team Lead and hand any role to any other CLI — e.g. `agy` as
  Team Lead with Claude as developer, or Claude as Team Lead with Codex as
  reviewer. The other CLI must be installed and logged in.

Every headless role returns a JSON result (schemas in [`schemas/`](schemas/)),
so roles on different CLIs share the same structured facts: the developer's
`files_changed`, the tester's `failures`, the reviewer's `issues`, and a
`blocked` list of anything the role wasn't allowed to do.

### Safety

Child agents never run with permission checks disabled — no
`--dangerously-skip-permissions` or equivalent. Each CLI runs sandboxed or
with a scoped tool set:

| CLI | developer / tester | code-reviewer |
|---|---|---|
| claude | auto mode (each action reviewed), scoped tools | plan mode, read-only tools |
| codex | `workspace-write` sandbox | `read-only` sandbox |
| agy | `--sandbox`, edits auto-accepted, other actions per your agy allowlist | `--sandbox`, plan mode |
| copilot | file edits only, no shell | read-only |

Anything a role can't do is reported back instead of worked around.

**Using `agy` for a role:** headless `agy` only runs tools your agy
settings pre-approve, and ends the run on the first action that would need
a prompt (even file reads). Add the actions you're comfortable with to
`permissions.allow` in `~/.gemini/antigravity-cli/settings.json` — for
example file reads/edits and your test command. When a run is denied, the
result's `error` names the exact actions agy refused.

The full protocol is in [`lib/dispatch.md`](lib/dispatch.md).

## Agents

| Agent | Role | Tools |
|---|---|---|
| `crewbench-developer` | Implements the scoped task | Read, Write, Edit, Bash, Grep, Glob |
| `crewbench-tester` | Verifies acceptance criteria, checks regressions | Read, Bash, Grep, Glob |
| `crewbench-code-reviewer` | Read-only static review | Read, Grep, Glob |
| `crewbench-ui-ux` | Design spec before implementation (opt-in) | Read, Write, Edit, Grep, Glob |

Role briefs live in [`agents/`](agents/) and are shared by every CLI.

## Layout

| Path | Used by |
|---|---|
| `.claude-plugin/` | Claude Code, Copilot CLI |
| `plugin.json` | Antigravity CLI (also read by Copilot CLI) |
| `.codex-plugin/`, `.agents/plugins/` | Codex CLI |
| `skills/`, `agents/`, `lib/`, `config/`, `schemas/`, `bin/` | all |

## License

MIT
