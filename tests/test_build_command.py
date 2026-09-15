import argparse

import pytest


def make_args(role="developer", cli="claude", model="m", effort="medium",
              timeout=1800, skip_permissions=False):
    ns = argparse.Namespace()
    ns.role, ns.cli, ns.model, ns.effort = role, cli, model, effort
    ns.timeout, ns.skip_permissions = timeout, skip_permissions
    return ns


CLIS = ["claude", "agy", "codex", "copilot"]
ROLES = ["developer", "tester", "code-reviewer", "ui-ux"]


@pytest.mark.parametrize("cli", CLIS)
@pytest.mark.parametrize("role", ROLES)
@pytest.mark.parametrize("skip", [False, True])
def test_build_command_shape(dispatch, tmp_path, cli, role, skip):
    d = dispatch
    args = make_args(role=role, cli=cli, skip_permissions=skip)
    schema_path = d.ROOT / "schemas" / f"{role}.json"
    prompt_file = tmp_path / "run.prompt.md"
    cmd, stdin, last_message = d.build_command(
        args, "FULL PROMPT " * 5000, prompt_file, schema_path, str(tmp_path), timeout_s=100)

    assert cmd[0] == cli
    d.check_argv_size(cmd)  # must never trip on a normal-sized prompt

    if cli in ("claude", "codex"):
        assert stdin is not None and "FULL PROMPT" in stdin
    else:
        # agy/copilot have no documented stdin prompt mode: prompt goes to a
        # file, and argv only carries a short pointer to it.
        assert stdin is None
        joined = " ".join(cmd)
        assert "FULL PROMPT" not in joined
        assert str(prompt_file) in joined

    if role in d.READ_ONLY:
        # code-reviewer is always read-only, skip flags must never appear
        assert "--dangerously-skip-permissions" not in cmd
        assert "danger-full-access" not in cmd
        assert "bypassPermissions" not in cmd
        assert "--allow-all-tools" not in cmd
    elif skip:
        if cli == "claude":
            assert "bypassPermissions" in cmd
        elif cli == "agy":
            assert "--dangerously-skip-permissions" in cmd
        elif cli == "codex":
            assert "danger-full-access" in cmd
        elif cli == "copilot":
            assert "--allow-all-tools" in cmd


def test_build_command_argv_guard_fires_on_oversized_prompt(dispatch, tmp_path):
    d = dispatch
    args = make_args(cli="agy")  # agy inlines a pointer, but let's force a huge one
    schema_path = d.ROOT / "schemas" / "developer.json"
    huge_path = "x" * (d.MAX_ARGV_BYTES + 1)
    with pytest.raises(ValueError):
        cmd, _, _ = d.build_command(args, "prompt", huge_path, schema_path, str(tmp_path), timeout_s=10)
        d.check_argv_size(cmd)


def test_agy_print_timeout_uses_remaining_time(dispatch, tmp_path):
    d = dispatch
    args = make_args(cli="agy", timeout=1800)
    schema_path = d.ROOT / "schemas" / "developer.json"
    cmd, _, _ = d.build_command(args, "prompt", tmp_path / "p.md", schema_path, str(tmp_path), timeout_s=42)
    i = cmd.index("--print-timeout")
    assert cmd[i + 1] == "42s"


def test_task_dir_and_round_name_run_artifacts(dispatch, git_repo, tmp_path, fake_cli_dir):
    import json
    import os
    import subprocess
    import sys

    task_dir = git_repo / ".crewbench" / "tasks" / "t1"
    handoff = tmp_path / "handoff.md"
    handoff.write_text("Task: trivial.\n")
    env = dict(os.environ)
    env["CREWBENCH_CLI_OVERRIDE_CLAUDE"] = str(fake_cli_dir / "hang_and_spawn.py")
    env["FAKE_CLI_SLEEP"] = "0.1"  # exits fast, no structured output -> a clean parse-error failure

    proc = subprocess.run(
        [sys.executable, str(dispatch.ROOT / "bin" / "crewbench_dispatch.py"),
         "--role", "tester", "--cli", "claude", "--model", "m", "--effort", "none",
         "--handoff", str(handoff), "--task-dir", str(task_dir), "--round", "2",
         "--timeout", "10"],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=20,
    )
    envelope = json.loads(proc.stdout)
    assert envelope["ok"] is False  # fake CLI never produces valid JSON — expected
    run_files = {p.name for p in (task_dir / "runs").iterdir()}
    assert "tester-r2.log" in run_files
    assert "tester-r2.prompt.md" in run_files
    assert "tester-r2.result.json" in run_files
    assert "tester-r2.raw.txt" in run_files


def test_unknown_cli_raises(dispatch, tmp_path):
    d = dispatch
    args = make_args(cli="not-a-cli")
    schema_path = d.ROOT / "schemas" / "developer.json"
    with pytest.raises(SystemExit):
        d.build_command(args, "prompt", tmp_path / "p.md", schema_path, str(tmp_path))
