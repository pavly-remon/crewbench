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

## Usage

```
/dev-squad:task <task description>
```

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
