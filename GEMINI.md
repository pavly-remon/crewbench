# crewbench

crewbench is a dev team run by a Team Lead: developer, tester, code-reviewer
and ui-ux roles. Its workflows are skills in this extension (`new-task`,
`test`, `review`, `design`, `team`), started by the `/crewbench:*` commands.
Only run a crewbench workflow when the user invokes one of those commands.

When a crewbench skill says to delegate to a role, follow `lib/dispatch.md`
in this extension's directory. In Gemini CLI, roles run through headless CLI
processes (`gemini -p`, or `claude`/`codex`/`copilot` if the lineup says so),
so each role gets the model the lineup asks for.
