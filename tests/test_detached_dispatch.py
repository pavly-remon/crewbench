import json
import os
import subprocess
import sys
import time

import pytest


def _dispatch_argv(dispatch):
    return [sys.executable, str(dispatch.ROOT / "bin" / "crewbench_dispatch.py")]


def test_start_then_wait_reports_done_envelope(dispatch, git_repo, fake_cli_dir):
    handoff = git_repo / "handoff.md"
    handoff.write_text("Task: anything\n")
    task_dir = git_repo / ".crewbench" / "tasks" / "t1"
    env = dict(os.environ)
    env["CREWBENCH_CLI_OVERRIDE_CLAUDE"] = str(fake_cli_dir / "quick_success.py")

    start = subprocess.run(
        _dispatch_argv(dispatch) + ["start", "--role", "developer", "--cli", "claude",
                                    "--model", "m", "--effort", "none",
                                    "--task-dir", str(task_dir), "--round", "1",
                                    "--handoff", str(handoff)],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    )
    assert start.returncode == 0
    started = json.loads(start.stdout)
    assert started["run"] == "developer-r1"
    assert started["pid"] > 0

    wait = subprocess.run(
        _dispatch_argv(dispatch) + ["wait", "--task-dir", str(task_dir),
                                    "--run", "developer-r1", "--max-seconds", "10",
                                    "--poll-interval", "0.2"],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    )
    assert wait.returncode == 0
    report = json.loads(wait.stdout)
    assert report["all_finished"] is True
    assert report["runs"]["developer-r1"]["state"] == "done"
    envelope = report["envelopes"]["developer-r1"]
    assert envelope["ok"] is True
    assert envelope["result"]["status"] == "done"


def test_wait_times_out_without_all_runs_finishing(dispatch, git_repo, fake_cli_dir):
    handoff = git_repo / "handoff.md"
    handoff.write_text("Task: anything\n")
    task_dir = git_repo / ".crewbench" / "tasks" / "t2"
    env = dict(os.environ)
    env["CREWBENCH_CLI_OVERRIDE_CLAUDE"] = str(fake_cli_dir / "quick_success.py")
    env["FAKE_CLI_SLEEP"] = "30"

    started = json.loads(subprocess.run(
        _dispatch_argv(dispatch) + ["start", "--role", "tester", "--cli", "claude",
                                    "--model", "m", "--effort", "none",
                                    "--task-dir", str(task_dir), "--round", "1",
                                    "--handoff", str(handoff), "--timeout", "60"],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    ).stdout)

    wait = subprocess.run(
        _dispatch_argv(dispatch) + ["wait", "--task-dir", str(task_dir),
                                    "--run", "tester-r1", "--max-seconds", "1",
                                    "--poll-interval", "0.2"],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    )
    assert wait.returncode == 1
    report = json.loads(wait.stdout)
    assert report["all_finished"] is False
    assert report["runs"]["tester-r1"]["state"] == "running"

    # Clean up the still-running fake CLI so it doesn't outlive the test.
    subprocess.run(
        _dispatch_argv(dispatch) + ["cancel", "--task-dir", str(task_dir), "--run", "tester-r1"],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    )


@pytest.mark.skipif(os.name == "nt", reason="process-group kill test targets POSIX")
def test_cancel_kills_the_running_process_group(dispatch, git_repo, fake_cli_dir):
    handoff = git_repo / "handoff.md"
    handoff.write_text("Task: anything\n")
    task_dir = git_repo / ".crewbench" / "tasks" / "t3"
    env = dict(os.environ)
    env["CREWBENCH_CLI_OVERRIDE_CLAUDE"] = str(fake_cli_dir / "quick_success.py")
    env["FAKE_CLI_SLEEP"] = "30"

    started = json.loads(subprocess.run(
        _dispatch_argv(dispatch) + ["start", "--role", "tester", "--cli", "claude",
                                    "--model", "m", "--effort", "none",
                                    "--task-dir", str(task_dir), "--round", "1",
                                    "--handoff", str(handoff), "--timeout", "60"],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    ).stdout)

    # Give the launcher a moment to spawn the fake CLI and record its pid.
    cli_pid = None
    for _ in range(20):
        try:
            status = json.loads((task_dir / "runs" / "status.json").read_text())
            cli_pid = status.get("tester-r1", {}).get("pid")
        except (OSError, ValueError):
            pass
        if cli_pid:
            break
        time.sleep(0.3)
    assert cli_pid, "fake CLI never reported its pid via status.json"

    cancel = subprocess.run(
        _dispatch_argv(dispatch) + ["cancel", "--task-dir", str(task_dir), "--run", "tester-r1"],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    )
    assert cancel.returncode == 0
    assert json.loads(cancel.stdout)["cancelled"] is True

    for _ in range(20):
        try:
            os.kill(cli_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.3)
    else:
        pytest.fail("cancelled run's process survived")

    status = json.loads((task_dir / "runs" / "status.json").read_text())
    assert status["tester-r1"]["state"] == "failed"
    assert status["tester-r1"]["error"] == "cancelled by user"
