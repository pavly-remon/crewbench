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
| `/crewbench:new-task <task description> [flags]` | Full workflow: scope, (optional) design, implement, test + review, fix loop |
| `/crewbench:test <scenario> [--yes]` | Tester writes and/or runs tests for one scenario and reports pass/fail |
| `/crewbench:review <branch> [base] [--yes]` | Code reviewer reviews a branch's changes against `base` (default branch if omitted) |
| `/crewbench:design <description> [--yes]` | UI/UX designer produces an implementable design spec |
| `/crewbench:team [change]` | Show or change the team lineup (CLI, model, effort per role) |
| `/crewbench:status [task-id]` | Recent tasks, or one task's phase/lineup/rounds/running runs. Read-only |
| `/crewbench:resume [task-id]` | Resume an interrupted task from its saved state, without re-asking the lineup |
| `/crewbench:doctor` | Check that every CLI in the lineup is installed, reachable and logged in from this host. Read-only |
| `/crewbench:profile [show\|refresh\|edit <change>]` | Show, (re)detect, or edit the project profile (`.crewbench/project.json`/`project.md`) |

In Codex, invoke the skills by name (`$new-task`, `$test`, `$review`,
`$design`, `$team`, `$status`, `$resume`, `$doctor`, `$profile`).

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
6. Run the deterministic gate (`format_check`/`lint`/`typecheck`/
   `test_changed` from `.crewbench/project.json`, whichever are
   configured). A failing step goes straight back to the developer as that
   round's fix list — no tester/reviewer run that round.
7. Once the gate passes (or nothing is configured), run the tester and
   code reviewer in parallel on the changed files, telling the tester which
   gate steps already passed.
8. Send one combined fix list back to the developer if the tester fails or
   the reviewer raises an issue at or above `loop.fix_threshold` (default
   `major`), up to `loop.max_rounds` (default 3). Later rounds review only
   the delta and re-check the previous round's issues/failures; stuck items
   (unresolved two rounds running) stop the loop early. Below-threshold
   issues are listed as optional follow-ups instead of triggering a round.
9. Report back in plain language. In worktree mode, ask how to bring the
   commit back (merge, cherry-pick, leave the branch, or nothing yet)
   before offering to remove the worktree.

The first `new-task` in a project with no `.crewbench/project.json` runs
`bin/crewbench_profile.py detect` and asks you to confirm the result once
before delegating anything — see `/crewbench:profile` to show, refresh or
edit it any time after that.

### Flags

Add these to any command's arguments to skip a question you already know
the answer to (stripped from the text, not treated as part of the
description):

| Flag | Skills | Effect |
|---|---|---|
| `--yes` | all | Skip the lineup-confirmation question; in `new-task`, also skip the UI/UX question (assumes no design unless `--design` is also given). Never skips a commit or push confirmation — those are always explicit. |
| `--design` | `new-task` | Use the ui-ux role without asking. |
| `--in-place` | `new-task` | Work directly in the current checkout for this task only, overriding `workspace.mode`. |
| `--rounds N` | `new-task` | Cap this task's fix loop at `N` rounds, overriding `loop.max_rounds`. |
| `--dev <cli[:model]>` | `new-task` | Run the developer role on `cli` (and `model`, if given) for this task only. |
| `--review <cli[:model]>` | `new-task` | Same, for `code-reviewer`. |

Flags only affect the one invocation — none of them get saved to
`.crewbench/team.json` on their own.

By default (`confirm_lineup: when_unsaved`), the Team Lead only asks about
the lineup when there's no saved `.crewbench/team.json` yet; once one
exists, it just shows the table and proceeds. Set `confirm_lineup` to
`always` (ask every time) or `never` (never ask) in `/crewbench:team` if
you want different behavior.

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
  },
  "confirm_lineup": "always"
}
```

`cli` is `host`, `claude`, `codex`, `agy` or `copilot`; `model` is a
tier or an exact model name; `effort` is `low`–`max`; `permissions` is
`safe` or `skip`. `loop.max_rounds` caps fix rounds (default 3);
`loop.fix_threshold` is the minimum reviewer severity that triggers another
round (`blocker` > `major` > `minor`, default `major`).
`workspace.mode` is `worktree` (default — `new-task` isolates each task in
`.crewbench/wt/<task-id>`) or `in-place`; `workspace.setup` are commands to
run once in a fresh worktree (e.g. install deps). `confirm_lineup` is
`always`, `when_unsaved` (default), or `never` — see "Flags" above.
Change any of these with `/crewbench:team`. Defaults live in
[`config/defaults.json`](config/defaults.json).

### How roles are run

- **Native subagent** when the role stays on the host CLI and the host can
  apply the model and effort (Claude Code always for model; Copilot when
  using the defaults).
- **Headless CLI** otherwise, through `bin/crewbench_dispatch.py`. Any CLI
  can be the Team Lead and hand any role to any other CLI — e.g. `agy` as
  Team Lead with Claude as developer, or Claude as Team Lead with Codex as
  reviewer. The other CLI must be installed and logged in; run
  `/crewbench:doctor` to check. Not every host x role-CLI combination has
  been run for real yet — see [`docs/compatibility.md`](docs/compatibility.md)
  for exactly what's verified today before relying on an unusual pairing.

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
`/crewbench:team` (and the first dispatch of a session) checks for this
allow-list entry and shows you the exact line to add if it's missing —
crewbench never edits the file itself.

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

Under the hood, every headless role is launched detached
(`crewbench_dispatch.py start`) and polled (`... wait`) rather than run in
the foreground and blocked on — this avoids depending on your own CLI's
shell-tool timeout or its background-job behavior, which vary by host. The
Team Lead can also `crewbench_dispatch.py cancel` a run mid-flight.

### Usage and timing

Every run's envelope carries a `usage` field with whatever timing/token/
cost data that CLI actually exposes — always wall-clock duration; tokens,
cost, and turn count when the CLI reports them (`null` otherwise; a run
never fails just because usage data is missing). The final report and
`/crewbench:status` both end with one line per role and a total:

```
developer · agy gemini-3.8-flash · 2 runs · 6m12s
tester · host (sonnet) · 1 run · 1m40s · $0.09 · 8.1k tokens
total: 3 runs · 7m52s
```

### Sandboxes and CLI health

A role CLI started from inside your own CLI's sandbox inherits it — it can
end up with no network, no write access to its own config/auth directory, or
blocked process spawning. `/crewbench:doctor` (or
`crewbench_dispatch.py doctor --cli <cli>`) checks a CLI is installed,
reachable, and logged in *from your current host* before it's dispatched to,
and the Team Lead runs it once per task for every non-host CLI in the
lineup. See [`docs/compatibility.md`](docs/compatibility.md) for which
host x role-CLI combinations have actually been run for real.

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
| `tests/`, `.github/workflows/`, `scripts/`, `docs/` | dev-only: pytest suite, CI, maintenance scripts, compatibility matrix — not needed at runtime |

In a project using crewbench, `.crewbench/` holds `team.json`,
`project.json` and `project.md` (all committable), plus an
auto-maintained `index.json` and per-task `tasks/<task-id>/` and (worktree
mode) `wt/<task-id>/` — see [`lib/dispatch.md`](lib/dispatch.md) §0.

## License

MIT
