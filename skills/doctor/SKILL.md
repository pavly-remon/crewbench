---
name: doctor
description: Check whether every CLI in the current team lineup is installed, reachable and logged in from this host — detects sandbox/auth problems before a task hits them. Read-only.
argument-hint: ""
disable-model-invocation: true
---

# crewbench: doctor

You check the crew's CLIs, not the task itself. You never delegate to a
role or change any file — this only reads and reports.

crewbench root: `${CLAUDE_PLUGIN_ROOT}` — if that still reads as a literal
placeholder, the root is the directory two levels above this SKILL.md.
Before anything else, run `python3 <root>/bin/crewbench_banner.py` and show
its output verbatim.

## Workflow

1. Detect the host: `python3 <root>/bin/crewbench_env.py whoami`. If `host`
   comes back `"unknown"`, ask the user once which CLI they're running
   crewbench from.

2. Build the current lineup the same way `/crewbench:team` does (defaults
   merged with `.crewbench/team.json`) so you know which CLIs are actually
   in use. If no lineup has been set up yet, check all four (`claude`,
   `codex`, `agy`, `copilot`).

3. For each CLI in the lineup that is **not** the detected host, run:

   ```
   python3 <root>/bin/crewbench_dispatch.py doctor --cli <cli>
   ```

   For the host's own CLI, a `doctor` check is still useful (confirms it's
   logged in and reachable) but skip the "installed" framing — you already
   know it's running.

4. Show one table: CLI, installed (version), logged in, reachable from this
   host, config dir writable. For anything red, give the concrete next step
   from that CLI's `errors` array (e.g. "log in outside the sandbox with
   `codex login`", "the host's shell tool blocks network — allow it for this
   session"). Never change sandbox or permission settings yourself, and
   never suggest working around a block instead of fixing it.

5. Cross-reference `<root>/docs/compatibility.md` for the detected host: for
   any role-CLI marked `partial` or `unsupported` for this host, mention the
   caveat even if `doctor` itself came back clean (compatibility problems
   and auth/network problems are different things — a CLI can be perfectly
   reachable and still be an unverified combination).

6. If everything is green, say so briefly — don't pad a clean report.
