# Fixtures

All files in this directory are **synthetic** — hand-written to match each
CLI's documented/observed output shape, not captured from a real run. Where a
field's exact name or nesting couldn't be confirmed against live output, the
shape follows what `crewbench_dispatch.py`'s parsers already expect (see
`Stream._claude`, `Stream._agy`, and `parse_output`).

- `claude_stream.jsonl` — a `claude --output-format stream-json` transcript:
  `system/init`, an `assistant` text block, an `assistant` tool_use block, a
  `user` tool_result error block, then the terminal `result` event with
  `structured_output` plus `duration_ms`/`duration_api_ms`/`num_turns`/
  `total_cost_usd`/`usage` (Phase 9's usage/timing fields) — this shape
  follows Claude Code's documented `stream-json` result event, not a fresh
  live capture from this session.
- `agy_stream.jsonl` — an `agy --output-format stream-json` transcript: an
  `init` event, a successful `step_update` tool event, a failed one with a
  "permission check failed" message (exercises denied-command capture), then
  the terminal `result` event with `structured_output`, `num_turns` and
  `usage` (`input_tokens`/`output_tokens`/`total_tokens`/`thinking_tokens`/
  `cache_read_tokens`) — this one *is* a real, live-confirmed shape (from a
  real headless code-reviewer dispatch during Final Verification), unlike
  the other fixtures in this file.
- `codex_last_message.json` — the JSON `codex exec --output-schema ... -o
  <file>` writes to its `-o` file: just the structured result object.
- `codex_stream.jsonl` — a `codex exec --json` transcript: `thread.started`
  (session id), an `agent_message` item, a `command_execution` item
  (started then completed), another `agent_message`, and the terminal
  `turn.completed` event with real token usage. Real, live-captured
  (codex-cli 0.154.0, Phase 0 milestone 4), lightly trimmed — unlike most
  of the other fixtures in this file, which are hand-written.
- `copilot_stdout.txt` — plain-text Copilot CLI output with the JSON result
  embedded in a fenced ` ```json ` block, the shape `extract_json()` has to
  pull out of free text.
