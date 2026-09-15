import os
import subprocess
import sys

import pytest


def test_dispatch_refuses_when_crewbench_role_already_set(dispatch, git_repo, tmp_path):
    handoff = git_repo / "handoff.md"
    handoff.write_text("Task: anything\n")
    env = dict(os.environ)
    env["CREWBENCH_ROLE"] = "developer"
    proc = subprocess.run(
        [sys.executable, str(dispatch.ROOT / "bin" / "crewbench_dispatch.py"),
         "--role", "tester", "--cli", "claude", "--model", "m", "--effort", "none",
         "--handoff", str(handoff)],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    )
    assert proc.returncode != 0
    assert "refuses to run" in proc.stderr
    assert "CREWBENCH_ROLE" in proc.stderr


def test_child_env_strips_other_hosts_and_sets_recursion_guard(dispatch, monkeypatch):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "abc")
    monkeypatch.setenv("CODEX_HOME", "/should/be/stripped")
    monkeypatch.setenv("COPILOT_MODEL", "should-be-kept-for-copilot")

    env = dispatch.child_env("codex", "developer", "20260101-0000-demo")
    assert "CLAUDECODE" not in env
    assert "CLAUDE_CODE_SESSION_ID" not in env
    assert env["CODEX_HOME"] == "/should/be/stripped"  # codex's own vars are kept when cli == codex
    assert "COPILOT_MODEL" not in env  # copilot's markers stripped for a non-copilot child
    assert env["CREWBENCH_ROLE"] == "developer"
    assert env["CREWBENCH_TASK"] == "20260101-0000-demo"

    env2 = dispatch.child_env("copilot", "tester", None)
    assert env2["COPILOT_MODEL"] == "should-be-kept-for-copilot"
    assert "CODEX_HOME" not in env2
    assert env2["CREWBENCH_TASK"] == ""


HOST_MARKERS = {
    "claude": {"CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "x"},
    "codex": {"CODEX_HOME": "/host/codex"},
    "agy": {"ANTIGRAVITY_DESKTOP_PRIMES": "1"},
    "copilot": {"COPILOT_MODEL": "gpt"},
}


@pytest.mark.parametrize("host", ["claude", "codex", "agy", "copilot"])
@pytest.mark.parametrize("role_cli", ["claude", "codex", "agy", "copilot"])
def test_child_env_matrix_never_leaks_a_different_hosts_markers(dispatch, monkeypatch, host, role_cli):
    """The 4x4 host x role-CLI matrix (Phase 6 item 6.6): whichever CLI is
    hosting the Team Lead, every other host's identity markers must be gone
    from a headless child's environment, and the child's own CLI's markers
    (if it happens to equal the host) must survive."""
    for h, markers in HOST_MARKERS.items():
        for key in markers:
            monkeypatch.delenv(key, raising=False)
    for key, value in HOST_MARKERS[host].items():
        monkeypatch.setenv(key, value)

    env = dispatch.child_env(role_cli, "developer", "task-1")

    for h, markers in HOST_MARKERS.items():
        if h == role_cli:
            continue
        for key in markers:
            assert key not in env, f"{key} (host {h}'s marker) leaked into a {role_cli} child"
    if host == role_cli:
        for key, value in HOST_MARKERS[host].items():
            assert env[key] == value
    assert env["CREWBENCH_ROLE"] == "developer"
    assert env["CREWBENCH_TASK"] == "task-1"
