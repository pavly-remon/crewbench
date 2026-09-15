# Fixtures

All files in this directory are **synthetic** — hand-written to match each
CLI's documented/observed output shape, not captured from a real run. Where a
field's exact name or nesting couldn't be confirmed against live output, the
shape follows what `crewbench_dispatch.py`'s parsers already expect (see
`Stream._claude`, `Stream._agy`, and `parse_output`).

- `claude_stream.jsonl` — a `claude --output-format stream-json` transcript:
  `system/init`, an `assistant` text block, an `assistant` tool_use block, a
  `user` tool_result error block, then the terminal `result` event with
  `structured_output`.
- `agy_stream.jsonl` — an `agy --output-format stream-json` transcript: an
  `init` event, a successful `step_update` tool event, a failed one with a
  "permission check failed" message (exercises denied-command capture), then
  the terminal `result` event with `structured_output`.
- `codex_last_message.json` — the JSON `codex exec --output-schema ... -o
  <file>` writes to its `-o` file: just the structured result object.
- `copilot_stdout.txt` — plain-text Copilot CLI output with the JSON result
  embedded in a fenced ` ```json ` block, the shape `extract_json()` has to
  pull out of free text.
