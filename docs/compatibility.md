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

## Structured events & usage investigation (Phase 0, milestone 4)

Investigated live on this machine, 2026-09-19: `codex-cli 0.154.0`,
`GitHub Copilot CLI 1.0.83`. Both turned out to have real structured
output — the phase plan's "VERIFY" guess (no such mode exists) was wrong
for both.

**codex**: `codex exec --help` documents `--json` ("Print events to stdout
as JSONL"). Confirmed live against a real `codex exec --json` call:
- `{"type": "thread.started", "thread_id": "<uuid>"}` — the session id
  (used for `resume_command`; `codex resume <id>` launches the interactive
  TUI, the headless equivalent confirmed live is `codex exec resume <id>` —
  the code had the wrong one before this pass, now fixed).
- `{"type": "item.completed"/"item.started", "item": {...}}` — `item.type`
  seen live: `agent_message` (assistant text), `command_execution` (shell
  tool call, with `command`/`exit_code`/`aggregated_output` once
  completed), `error` (a codex-internal warning, e.g. a hook-config
  clamp — not a tool failure).
- `{"type": "turn.completed", "usage": {"input_tokens",
  "cached_input_tokens", "cache_write_input_tokens", "output_tokens",
  "reasoning_output_tokens"}}` — real per-run token usage. No cost field
  present; `cost_usd` stays `null` rather than guessed.
- `{"type": "turn.failed", "error": {"message": ...}}` on failure (e.g. an
  unsupported model name for the account's plan — hit live during this
  investigation).
- The existing `--output-schema <file> -o <file>` mechanism (unchanged)
  remains the source of truth for the final structured `result` — the
  same JSON also appears as the last `agent_message.text`, but the file is
  more robust to log-parsing edge cases, so `parse_output()` still reads it
  first and only falls back to `stream.final`'s `turn.failed` error when
  the file wasn't written.
- Wired into `Stream._codex()` and `extract_usage()`/`parse_output()`'s
  codex branches; `--json` added to codex's `build_command()`. See
  `docs/app/contract/events.md` and `tests/fixtures/codex_stream.jsonl`
  (a real captured stream, lightly trimmed) for the parser's test coverage.
- Verified with two full real dispatches through `crewbench_dispatch.py`
  itself (not just the raw CLI) during this pass: one hitting
  `turn.failed` (unsupported model), one succeeding end-to-end
  (`code-reviewer` role, real structured `result`, real `usage:
  {input_tokens: 33425, output_tokens: 343}`, correct `resume_command`).

**copilot**: `copilot --help` documents `--output-format json` (JSONL
events, a much larger and more elaborate schema than codex's — session/
turn/model/tool lifecycle events) and, more directly useful,
`--usage-output-file <file>`, which writes a JSON summary after the run
finishes. Confirmed live: `{"lastCallInputTokens", "lastCallOutputTokens",
"totalNanoAiu", "totalPremiumRequestCost", "modelMetrics": {...}, ...}`.
- `lastCallInputTokens`/`lastCallOutputTokens` are this run's usage, not a
  running session total — the right thing to fold into `state.json`'s
  per-run usage aggregation. `totalNanoAiu` is an internal AI-unit credit
  metric, not USD — `cost_usd` stays `null` rather than a wrong
  conversion (`VERIFY` if copilot ever exposes an actual dollar figure).
- Only `--usage-output-file` was wired in this pass (added to copilot's
  `build_command()`, read back by `extract_usage()`), since it's a small,
  additive, low-risk change with an unambiguous shape. The live
  `--output-format json` event stream was inspected but **not** wired into
  `Stream`/`parse_output` — copilot's `-p`/`-s` plain-text mode already
  works for the final result, and the live-event schema is large enough
  (session/turn/model/tool/message-delta lifecycle, not the compact
  request/response shape codex and agy use) that parsing it properly is
  its own chunk of work, better scoped as its own follow-up than folded
  into this milestone. The best-effort text-scan fallback
  (`_usage_from_text`) stays in place for both CLIs only as a
  last-resort — for copilot, if `--usage-output-file` is ever missing (an
  older version without the flag); for codex it's now fully unused (dead
  as of this change, kept only because copilot still needs the function).
- Verified with one full real dispatch through `crewbench_dispatch.py`:
  `code-reviewer` role, real structured `result`, real `usage:
  {input_tokens: 26709, output_tokens: 105}`.

## How to update this file

Run `scripts/matrix_smoke.py` from each host you can access, with as many
role CLIs installed and logged in as possible, and replace the relevant
cells with `verified (real)` plus the date and versions. It never runs in
CI (it costs real usage and needs real logins) — this file is the durable
record of what's actually been checked.
