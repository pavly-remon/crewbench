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
| `/crewbench:status [task-id]` | Recent tasks, or one task's phase/lineup/rounds/running runs. Read-only |
| `/crewbench:resume [task-id]` | Resume an interrupted task from its saved state, without re-asking the lineup |

In Codex, invoke the skills by name (`$new-task`, `$test`, `$review`,
`$design`, `$team`, `$status`, `$resume`).

`test`, `review`, and `design` only report — they never change your code. Each
offers to hand its results to `/crewbench:new-task` if you want something
fixed or built.

### new-task workflow

The Team Lead will:

1. Ask clarifying questions if the task is underspecified.
2. Offer a UI/UX spec if the task touches the UI (only runs if you say yes).
3. Show the team lineup and let you keep or change it.
4. Isolate the task in a git worktree (`.crewbench/wt/<task-id>`, default —
   set `workspace.mode: in-place` to work directly in your checkout
   instead). Asks first if your tree is dirty, and about running an
   install command in the fresh worktree.
5. Hand implementation to the developer.
6. Run the tester and code reviewer in parallel on the changed files.
7. Send one combined fix list back to the developer if the tester fails or
   the reviewer raises an issue at or above `loop.fix_threshold` (default
   `major`), up to `loop.max_rounds` (default 3). Later rounds review only
   the delta and re-check the previous round's issues/failures; stuck items
   (unresolved two rounds running) stop the loop early. Below-threshold
   issues are listed as optional follow-ups instead of triggering a round.
8. Report back in plain language. In worktree mode, ask how to bring the
   commit back (merge, cherry-pick, leave the branch, or nothing yet)
   before offering to remove the worktree.

## Team lineup

Default lineup — cheaper model for building, stronger model for checking,
all at medium effort, all on the CLI you're running:

| Role | CLI | Model tier | Effort | Permissions |
|---|---|---|---|---|
| developer | host | cheap | medium | skip |
| tester | host | strong | medium | safe |
| code-reviewer | host | strong | medium | safe (always read-only) |
| ui-ux | host | cheap | medium | safe |

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
  },
  "loop": {
    "max_rounds": 5,
    "fix_threshold": "blocker"
  },
  "workspace": {
    "mode": "in-place",
    "setup": ["npm ci"]
  }
}
```

`cli` is `host`, `claude`, `codex`, `agy` or `copilot`; `model` is a
tier or an exact model name; `effort` is `low`–`max`; `permissions` is
`safe` or `skip`. `loop.max_rounds` caps fix rounds (default 3);
`loop.fix_threshold` is the minimum reviewer severity that triggers another
round (`blocker` > `major` > `minor`, default `major`).
`workspace.mode` is `worktree` (default — `new-task` isolates each task in
`.crewbench/wt/<task-id>`) or `in-place`; `workspace.setup` are commands to
run once in a fresh worktree (e.g. install deps). Change any of these with
`/crewbench:team`. Defaults live in
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

Each role runs in one of two permission modes, set per role in the lineup.

**`safe`** — sandboxed or with a scoped tool set:

| CLI | developer / tester | code-reviewer |
|---|---|---|
| claude | auto mode (each action reviewed), scoped tools | plan mode, read-only tools |
| codex | `workspace-write` sandbox | `read-only` sandbox |
| agy | `--sandbox`, project reads/edits allowed, shell commands per your agy allowlist | `--sandbox`, plan mode |
| copilot | file edits only, no shell | read-only |

**`skip`** (the developer's default) — permission checks skipped so the
role never stops for approval: Claude `bypassPermissions`, agy
`--dangerously-skip-permissions` (still sandboxed), Codex
`danger-full-access`, Copilot `--allow-all-tools`. A `skip` role can run any
command on your machine; set it to `safe` in `.crewbench/team.json` or via
`/crewbench:team` if that's not what you want.

### Commits

Crew roles never commit or push — it's in their instructions, not enforced
by permission rules. Only the Team Lead commits, after the tester and
reviewer approve and you confirm; pushing asks you separately. If a role
changes git history anyway, its result carries a warning and the Team Lead
tells you before doing anything else.

**Launching `skip` runs from Claude Code:** auto mode blocks starting an
agent with permission checks skipped. Approve the dispatch when prompted
(`/permissions` → Recently denied → `r`), or allow it in your own
`~/.claude/settings.json`, e.g.
`"permissions": {"allow": ["Bash(python3 */crewbench_dispatch.py *)"]}`.

**Using `agy` for a role:** reads and edits inside the project work out of
the box, and `agy` roles are told to use their file tools instead of
`ls`/`cat`/`grep`. Shell commands only run if they match `permissions.allow`
in `~/.gemini/antigravity-cli/settings.json`. agy matches those rules as
word-by-word prefixes, and `*` only works on its own:

| Rule | Allows |
|---|---|
| `command(npm test)` | `npm test`, `npm test -- --watch` |
| `command(ls)` | `ls`, `ls -la` |
| `command(regex:npm run (build\|lint\|test))` | those three scripts |
| `command(ls*)` | nothing — agy reads `ls*` literally |

If a role's run is stopped by a denied command anyway, crewbench resumes
the same `agy` session, tells it the command stays denied, and lets it
finish (up to 2 times). Denied commands show up in the result's
`permission_denials`, and allow rules that can never match show up in
`warnings`.

### Watching a role work

Each headless role writes a live log. The Team Lead tells you the command
when a role starts:

```
tail -f .crewbench/tasks/<task-id>/runs/developer-r1.log
```

```
[01:22:33] session started (gemini-3.8-flash) id=1c16c942-…
[01:22:38] tool: view_file {"AbsolutePath": "…/calc.py"}
[01:22:42] tool: replace_file_content {"TargetFile": "…/calc.py"}
[01:22:49] finished: SUCCESS
```

`<task-dir>/runs/status.json` lists every run (running / done / failed) with
its log and session id — or just ask `/crewbench:status <task-id>`. When a
role finishes, its result includes a `resume_command` — `agy --conversation
<id>`, `claude --resume <id>`, `codex resume <id>` — to open the full
session in that CLI.

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
| `tests/`, `.github/workflows/`, `scripts/` | dev-only: pytest suite, CI, maintenance scripts — not needed at runtime |

In a project using crewbench, `.crewbench/` holds `team.json`,
`project.json` and `project.md` (all committable), plus an
auto-maintained `index.json` and per-task `tasks/<task-id>/` and (worktree
mode) `wt/<task-id>/` — see [`lib/dispatch.md`](lib/dispatch.md) §0.

## License

MIT
