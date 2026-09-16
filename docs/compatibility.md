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
all four CLIs installed and logged in. Dated 2026-09-16 (Final
Verification pass; `doctor`-only checks below dated 2026-09-15). Versions:
`claude` 2.1.273, `codex-cli` 0.154.0, `agy` 1.2.3, GitHub Copilot CLI
1.0.83.

| Host \\ role CLI | claude | codex | agy | copilot |
|---|---|---|---|---|
| **Claude Code** | verified (real) — real headless `code-reviewer` dispatch against a throwaway repo, valid envelope, correct verdict; this is also the CLI every automated test in this repo runs under | verified (real) — same real dispatch; found and fixed a real bug in the process (below) | verified (real) — same real dispatch; also the first live confirmation of agy's real usage-field shape (Phase 9) | verified (real) — same real dispatch |
| **Codex** | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) |
| **agy** | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) |
| **Copilot CLI** | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) | verified (fake CLI only) |

**What "verified (real)" actually covers on the Claude Code row:** a live
`crewbench_dispatch.py doctor --cli <cli>` for all four CLIs (2026-09-15,
Phase 6), confirming each is installed, its config dir is writable, its
API host is reachable, and it's logged in; **and**, as of this Final
Verification pass (2026-09-16), one real headless `code-reviewer` dispatch
per role CLI against a tiny throwaway repo with a one-line bug (`return
a - b` instead of `a + b`), confirming a valid, schema-passing envelope
and a correct review verdict from all four. **Real bug found and fixed by
this check**: codex's real API call rejected `schemas/code-reviewer.json`
outright with a 400 (`'required' is required to be supplied and to be an
array including every key in properties`) — OpenAI's structured-outputs
strict mode, which `codex exec --output-schema` uses, requires every
property to be in `required`, which our schemas intentionally don't do for
genuinely optional fields (`previous_issues`, tester's `screenshots`).
Fixed with `codex_strict_schema()` (a codex-only transformed copy of the
schema: every property added to `required`, optional ones get `null`
unioned into their type) plus `normalize_optional_nulls()` (treats an
explicit optional-field `null` codex now sends back the same as an
omitted key, for `validate()` and every other CLI). Re-ran live after the
fix: `ok: true`. This did **not** cover a full mixed-lineup `new-task` run
(worktree pre-flight, gate, parallel tester+reviewer, fix loop, commit) —
that's still deferred, noted below.

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
