from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def feed_all(stream, path):
    for line in path.read_text().splitlines():
        stream.feed(line)


def test_claude_usage_extracted_from_result_event(dispatch):
    stream = dispatch.Stream("claude")
    feed_all(stream, FIXTURES / "claude_stream.jsonl")
    usage = dispatch.extract_usage("claude", stream, "", 41.2)
    assert usage["duration_s"] == 41.2
    assert usage["input_tokens"] == 15234
    assert usage["output_tokens"] == 812
    assert usage["total_tokens"] == 15234 + 812
    assert usage["cost_usd"] == 0.0431
    assert usage["num_turns"] == 6


def test_agy_usage_extracted_from_fixture_result_event(dispatch):
    stream = dispatch.Stream("agy")
    feed_all(stream, FIXTURES / "agy_stream.jsonl")
    usage = dispatch.extract_usage("agy", stream, "", 12.5)
    assert usage["duration_s"] == 12.5
    assert usage["input_tokens"] == 5083
    assert usage["output_tokens"] == 137
    assert usage["total_tokens"] == 5220
    assert usage["num_turns"] == 2
    assert usage["cost_usd"] is None  # no cost field in the confirmed-live shape


def test_agy_usage_defaults_to_null_when_absent(dispatch):
    stream = dispatch.Stream("agy")
    stream.final = {"structured_output": {"status": "done"}}
    usage = dispatch.extract_usage("agy", stream, "", 12.5)
    assert usage["duration_s"] == 12.5
    assert usage["input_tokens"] is None
    assert usage["output_tokens"] is None
    assert usage["total_tokens"] is None
    assert usage["cost_usd"] is None
    assert usage["num_turns"] is None


def test_agy_usage_reads_plausible_usage_subobject_if_present(dispatch):
    stream = dispatch.Stream("agy")
    stream.final = {"structured_output": {"status": "done"},
                     "usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
                     "cost_usd": 0.01}
    usage = dispatch.extract_usage("agy", stream, "", 5.0)
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 50
    assert usage["total_tokens"] == 150
    assert usage["cost_usd"] == 0.01


def test_agy_usage_reads_num_turns_and_extra_usage_fields_confirmed_live(dispatch):
    # Shape confirmed via a real headless code-reviewer dispatch during
    # Final Verification: agy's result event carries num_turns at the top
    # level and extra usage fields (thinking_tokens, cache_read_tokens)
    # we don't extract but must not choke on.
    stream = dispatch.Stream("agy")
    stream.final = {
        "structured_output": {"status": "done"}, "num_turns": 3,
        "usage": {"input_tokens": 36960, "output_tokens": 249, "total_tokens": 37209,
                  "thinking_tokens": 0, "cache_read_tokens": 48947},
    }
    usage = dispatch.extract_usage("agy", stream, "", 12.9)
    assert usage["num_turns"] == 3
    assert usage["input_tokens"] == 36960
    assert usage["total_tokens"] == 37209
    assert usage["cost_usd"] is None


def test_codex_usage_from_text_scan(dispatch):
    stream = dispatch.Stream("codex")
    usage = dispatch.extract_usage("codex", stream, "done.\nTokens used: 1,234\n", 3.0)
    assert usage["total_tokens"] == 1234


def test_copilot_usage_is_null_when_no_usage_text_found(dispatch):
    stream = dispatch.Stream("copilot")
    usage = dispatch.extract_usage("copilot", stream, "plain output with no usage info", 2.0)
    assert usage["total_tokens"] is None
    assert usage["duration_s"] == 2.0


def test_usage_from_text_matches_total_tokens_phrasing(dispatch):
    assert dispatch._usage_from_text("Total tokens: 9,001") == 9001
    assert dispatch._usage_from_text("no numbers here") is None
    assert dispatch._usage_from_text("") is None
    assert dispatch._usage_from_text(None) is None
