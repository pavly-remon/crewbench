# dev-squad

A Claude Code plugin that runs a task through a five-role dev team:
a Team Lead that scopes and delegates, plus Developer, Tester, Code Reviewer,
and (opt-in) UI/UX Designer subagents.

## Install

In Claude Code:

```
/plugin marketplace add pavly-remon/dev-squad
/plugin install dev-squad@dev-squad-marketplace
```

In GitHub Copilot CLI:

```
copilot plugin marketplace add pavly-remon/dev-squad
copilot plugin install dev-squad@dev-squad-marketplace
```

## Commands

| Command | What it does |
|---|---|
| `/dev-squad:new-task <task description>` | Full workflow: scope, (optional) design, implement, test + review, fix loop |
| `/dev-squad:test <scenario>` | Tester writes and/or runs tests for one scenario and reports pass/fail |
| `/dev-squad:review <branch> [base]` | Code reviewer reviews a branch's changes against `base` (default branch if omitted) |
| `/dev-squad:design <description>` | UI/UX designer produces an implementable design spec |

`test`, `review`, and `design` only report — they never change your code. Each
offers to hand its results to `/dev-squad:new-task` if you want something fixed
or built.

### new-task workflow

The Team Lead will:

1. Ask clarifying questions if the task is underspecified.
2. Offer a UI/UX spec if the task touches the UI (only runs if you say yes).
3. Hand implementation to the developer subagent.
4. Run the tester and code reviewer in parallel on the changed files.
5. Send one combined fix list back to the developer if either flags issues,
   up to 3 rounds.
6. Report back in plain language.

## Agents

| Agent | Role | Tools |
|---|---|---|
| `dev-squad-developer` | Implements the scoped task | Read, Write, Edit, Bash, Grep, Glob |
| `dev-squad-tester` | Verifies acceptance criteria, checks regressions | Read, Bash, Grep, Glob |
| `dev-squad-code-reviewer` | Read-only static review | Read, Grep, Glob |
| `dev-squad-ui-ux` | Design spec before implementation (opt-in) | Read, Write, Edit, Grep, Glob |

## License

MIT
