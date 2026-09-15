import pytest


@pytest.mark.parametrize("text,expected_substr", [
    ("Error: getaddrinfo ENOTFOUND api.anthropic.com", "blocks network"),
    ("connect ECONNREFUSED 127.0.0.1:443", "blocks network"),
    ("EACCES: permission denied, open '/Users/x/.codex/auth.json'", "config/auth directory"),
    ("Please run: claude auth login", "doesn't appear to be logged in"),
    ("401 Unauthorized", "doesn't appear to be logged in"),
    ("some unrelated tool error", None),
])
def test_classify_sandbox_error(dispatch, text, expected_substr):
    hint = dispatch.classify_sandbox_error(text)
    if expected_substr is None:
        assert hint is None
    else:
        assert hint is not None and expected_substr in hint


def test_dispatch_error_gets_sandbox_hint_prefix(dispatch, git_repo, fake_cli_dir):
    handoff = git_repo / "handoff.md"
    handoff.write_text("Task: anything\n")
    import os
    import subprocess
    import sys
    env = dict(os.environ)
    env["CREWBENCH_CLI_OVERRIDE_CLAUDE"] = str(fake_cli_dir / "fake_status_cli.py")
    env["FAKE_STATUS_FAIL"] = "getaddrinfo ENOTFOUND api.anthropic.com"
    proc = subprocess.run(
        [sys.executable, str(dispatch.ROOT / "bin" / "crewbench_dispatch.py"),
         "--role", "developer", "--cli", "claude", "--model", "m", "--effort", "none",
         "--handoff", str(handoff)],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    )
    import json
    envelope = json.loads(proc.stdout)
    assert envelope["ok"] is False
    assert "blocks network" in envelope["error"]
