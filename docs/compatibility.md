# Cross-CLI compatibility matrix

crewbench's Team Lead can run in any of four host CLIs, and can delegate any
role to any of the four CLIs headlessly (or natively where the role's CLI is
the host — see `lib/dispatch.md` §3). This is a 4 x 4 matrix of **host** x
**role CLI**, and every cell is tracked here rather than assumed. Statuses:

- **verified (real)** — an actual `new-task` (or at least one real headless
  role dispatch) was run with the Team Lead in that host, delegating to that
  role CLI, against a real installed CLI, and it produced a valid envelope.
- **verified (fake CLI only)** — covered by the automated pytest suite,
  which simulates the host (env vars) and the role CLI (a small script
  standing in for the real one) and drives `crewbench_dispatch.py`
  (including `start`/`wait`/`cancel`, schema parsing, env stripping, the
  recursion guard, and simulated sandbox-failure error text) exactly as
  `lib/dispatch.md` instructs the Team Lead to. This exercises the dispatch
  script's logic thoroughly but never launches a real CLI process.
- **partial** — some real evidence exists, with a specific caveat.
- **unsupported** — no evidence yet, or a known problem with no workaround.

## Matrix

Development machine for this pass: macOS (darwin), Python 3.9+ available,
all four CLIs installed and logged in. Dated 2026-09-15. Versions: `claude`
2.1.273, `codex-cli` 0.154.0, `agy` 1.2.3, GitHub Copilot CLI 1.0.83.

| Host \\ role CLI | claude | codex | agy | copilot |
|---|---|---|---|---|
| **Claude Code** | verified (real) — `doctor` ran live and passed; this is also the CLI every automated test in this repo runs under | verified (real) — `doctor` ran live and passed | verified (real) — `doctor` ran live and passed | verified (real) — `doctor` ran live and passed |
| **Codex** | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) |
| **agy** | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) |
| **Copilot CLI** | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) |

**What "verified (real)" actually covers on the Claude Code row:** a live
`crewbench_dispatch.py doctor --cli <cli>` for all four CLIs, confirming
each is installed, its config dir is writable, its API host is reachable,
and it's logged in — see the real output captured during this pass in the
Phase 6 checkpoint notes. It does **not** yet cover a full real headless
role dispatch (an actual `claude -p`/`codex exec`/`agy -p`/`copilot -p`
invocation with a real task) or a full `new-task` run with a mixed lineup —
those cost real API/CLI usage across four providers and are deliberately
deferred to this project's "Final verification" pass (see `CHECKPOINT.md`),
same as every other phase's real-CLI smoke testing.

**Every other row is untested with a live host switch.** This development
session always runs as the Claude Code host — there was no way to actually
launch codex/agy/copilot *as the Team Lead* and drive a real `new-task` from
inside them in this pass. The dispatch script's logic is host-agnostic (it
doesn't branch on which CLI is hosting it, only on `--cli` for the role), so
the code path is the same one exercised on the Claude Code row and by the
fake-CLI test matrix — but that is an argument for *why it should work*, not
a substitute for having actually run it. Treat these rows as `partial` in
practice until someone runs `scripts/matrix_smoke.py` from each host.

## Known caveats (apply regardless of cell)

- **Copilot native custom-agent routing** is currently unreachable (no
  per-call model override found in `copilot --help`) — Copilot roles always
  go through the headless route. See `lib/dispatch.md` §3.
- **Copilot auth check** (`doctor`) has no dedicated status command; it
  falls back to checking for a stored credential or token env var, which is
  weaker evidence than the other three CLIs' checks. VERIFY if Copilot adds
  one.
- **agy auth check** (`doctor`) falls back to `agy models`, a real (small)
  network+auth call, since agy has no dedicated status command either.
- **Windows** host detection (`crewbench_env.py whoami`'s parent-process
  walk) is untested — no Windows machine was available for this pass.
- **Plugin-cache paths** in `lib/dispatch.md`'s root-resolution fallback are
  confirmed for Claude Code, Codex and agy (all installed here); Copilot's
  is inferred from `copilot plugin --help`'s described layout, not
  confirmed against a real install (none existed on this machine).

## How to update this file

Run `scripts/matrix_smoke.py` from each host you can access, with as many
role CLIs installed and logged in as possible, and replace the relevant
cells with `verified (real)` plus the date and versions. It never runs in
CI (it costs real usage and needs real logins) — this file is the durable
record of what's actually been checked.
