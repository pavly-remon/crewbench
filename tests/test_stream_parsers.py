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


def test_copilot_stdout_extraction(dispatch):
    stream = dispatch.Stream("copilot")
    stdout = (FIXTURES / "copilot_stdout.txt").read_text()
    result, denials, error = dispatch.parse_output("copilot", stream, stdout, None)
    assert error is None
    assert result["status"] == "done"
    assert result["files_changed"] == ["src/calc.py"]


def test_claude_stream_no_result_event_is_an_error(dispatch):
    stream = dispatch.Stream("claude")
    stream.feed('{"type": "system", "subtype": "init", "session_id": "x", "model": "sonnet"}')
    result, denials, error = dispatch.parse_output("claude", stream, "", None)
    assert result is None
    assert error == "no result event in output"
