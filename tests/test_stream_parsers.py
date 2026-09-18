from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def feed_all(stream, path):
    log_lines = []
    for line in path.read_text().splitlines():
        log_lines += stream.feed(line)
    return log_lines


def test_claude_stream_parser(dispatch):
    stream = dispatch.Stream("claude")
    log_lines = feed_all(stream, FIXTURES / "claude_stream.jsonl")
    assert stream.session_id == "c1a2b3c4-0000-0000-0000-000000000001"
    assert stream.final is not None
    assert stream.final["structured_output"]["status"] == "done"
    assert any("says:" in line for line in log_lines)
    assert any("tool: Read" in line for line in log_lines)
    assert any("error:" in line for line in log_lines)

    result, denials, error = dispatch.parse_output("claude", stream, "", None)
    assert error is None
    assert result["files_changed"] == ["src/calc.py"]


def test_agy_stream_parser_captures_denied_command(dispatch):
    stream = dispatch.Stream("agy")
    feed_all(stream, FIXTURES / "agy_stream.jsonl")
    assert stream.session_id == "a1b2c3d4-0000-0000-0000-000000000002"
    assert stream.denied_commands == ["npm test"]
    assert stream.final["structured_output"]["status"] == "blocked"

    result, denials, error = dispatch.parse_output("agy", stream, "", None)
    assert error is None
    assert result["status"] == "blocked"


def test_codex_last_message_file(dispatch, tmp_path):
    stream = dispatch.Stream("codex")
    last = tmp_path / "last.json"
    last.write_text((FIXTURES / "codex_last_message.json").read_text())
    result, denials, error = dispatch.parse_output("codex", stream, "", last)
    assert error is None
    assert result["status"] == "done"
    assert denials == []


def test_codex_stream_parser(dispatch):
    # Confirmed live (`codex exec --json`, codex-cli 0.154.0) — see
    # docs/compatibility.md's Phase 0 investigation notes.
    stream = dispatch.Stream("codex")
    log_lines = feed_all(stream, FIXTURES / "codex_stream.jsonl")
    assert stream.session_id == "01a0b679-e908-70d1-8ab6-f1c95fc49c42"
    assert any(line.startswith("says:") for line in log_lines)
    assert any(line.startswith("tool: shell") for line in log_lines)
    assert stream.final["usage"]["input_tokens"] == 30712

    usage = dispatch.extract_usage("codex", stream, "", 4.1)
    assert usage["input_tokens"] == 30712
    assert usage["output_tokens"] == 77
    assert usage["total_tokens"] == 30712 + 77
    assert usage["cost_usd"] is None  # not present in the confirmed-live shape

    # The --output-schema/-o file, not the stream, is still the source of
    # truth for the structured result -- confirm the stream doesn't override it.
    result, denials, error = dispatch.parse_output("codex", stream, "", None)
    assert error == "no result event in output"


def test_codex_stream_parser_tool_error_is_classified_correctly(dispatch):
    stream = dispatch.Stream("codex")
    stream.feed('{"type": "thread.started", "thread_id": "t1"}')
    log_lines = stream.feed(
        '{"type": "item.completed", "item": {"id": "i1", "type": "command_execution", '
        '"command": "touch /etc/x", "exit_code": 1, "aggregated_output": "Operation not permitted"}}'
    )
    assert log_lines and dispatch.classify_log_entry(log_lines[0]) == "run.tool_error"


def test_codex_stream_parser_turn_failed_without_last_message(dispatch):
    stream = dispatch.Stream("codex")
    stream.feed('{"type": "thread.started", "thread_id": "t1"}')
    stream.feed('{"type": "turn.failed", "error": {"message": "model not supported"}}')
    result, denials, error = dispatch.parse_output("codex", stream, "", None)
    assert result is None
    assert error == "model not supported"


def test_copilot_stdout_extraction(dispatch):
    stream = dispatch.Stream("copilot")
    stdout = (FIXTURES / "copilot_stdout.txt").read_text()
    result, denials, error = dispatch.parse_output("copilot", stream, stdout, None)
    assert error is None
    assert result["status"] == "done"
    assert result["files_changed"] == ["src/calc.py"]


def test_codex_resume_command_uses_the_headless_exec_subcommand(dispatch):
    # Confirmed live (`codex resume --help` vs `codex exec resume --help`,
    # codex-cli 0.154.0): `codex resume <id>` launches the interactive TUI;
    # the headless equivalent (matching how every other CLI here resumes
    # non-interactively) is `codex exec resume <id>`.
    assert dispatch.resume_command("codex", "abc-123") == "codex exec resume abc-123"


def test_claude_stream_no_result_event_is_an_error(dispatch):
    stream = dispatch.Stream("claude")
    stream.feed('{"type": "system", "subtype": "init", "session_id": "x", "model": "sonnet"}')
    result, denials, error = dispatch.parse_output("claude", stream, "", None)
    assert result is None
    assert error == "no result event in output"
