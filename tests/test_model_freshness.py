import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
crewbench_env = importlib.import_module("crewbench_env")

FAKE_CLI = str(Path(__file__).parent / "fixtures" / "fake_clis" / "fake_status_cli.py")


def test_list_models_unknown_cli_returns_none_with_reason():
    ids, error = crewbench_env.list_models("claude", "claude")
    assert ids is None
    assert "claude" in error


def test_list_models_parses_tab_separated_ids():
    ids, error = crewbench_env.list_models("agy", FAKE_CLI)
    assert error is None
    assert ids == ["fake-model-1"]


def test_check_model_found():
    result = crewbench_env.check_model("agy", FAKE_CLI, "fake-model-1")
    assert result["checked"] is True
    assert result["found"] is True
    assert result["closest"] == []


def test_check_model_not_found_suggests_closest():
    result = crewbench_env.check_model("agy", FAKE_CLI, "fake-model-2")
    assert result["checked"] is True
    assert result["found"] is False
    assert "fake-model-1" in result["closest"]


def test_check_model_prefers_prefix_match_over_fuzzy():
    ids, _ = crewbench_env.list_models("agy", FAKE_CLI)
    assert ids == ["fake-model-1"]
    # Simulate a real agy-shaped catalog (effort-suffixed ids) via list_models'
    # already-parsed output shape, exercised through check_model's own logic.
    real_available = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"]

    def fake_list_models(cli, cli_path):
        return real_available, None

    original = crewbench_env.list_models
    crewbench_env.list_models = fake_list_models
    try:
        result = crewbench_env.check_model("agy", "unused", "gemini-3.8-flash")
    finally:
        crewbench_env.list_models = original
    assert result["found"] is False
    assert result["closest"] == real_available


def test_check_model_no_listing_command_is_not_checked_not_a_failure():
    result = crewbench_env.check_model("claude", "claude", "sonnet")
    assert result["checked"] is False
    assert result["found"] is None
    assert result["error"]
