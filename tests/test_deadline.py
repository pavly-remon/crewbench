import json
import os
import subprocess
import sys
import time

import pytest

pytestmark = pytest.mark.skipif(os.name == "nt", reason="process-group kill test targets POSIX; "
                                                        "Windows uses taskkill /T /F, exercised manually")


def test_timeout_kills_whole_process_group_no_orphans(dispatch, git_repo, tmp_path, fake_cli_dir):
    handoff = git_repo / "handoff.md"
    handoff.write_text("Task: do nothing, this run is expected to time out.\n")

    pid_file = tmp_path / "cli.pid"
    child_pid_file = tmp_path / "child.pid"
    env = dict(os.environ)
    env["CREWBENCH_CLI_OVERRIDE_CLAUDE"] = str(fake_cli_dir / "hang_and_spawn.py")
    env["FAKE_CLI_PID_FILE"] = str(pid_file)
    env["FAKE_CLI_CHILD_PID_FILE"] = str(child_pid_file)
    env["FAKE_CLI_SLEEP"] = "30"

    start = time.time()
    proc = subprocess.run(
        [sys.executable, str(dispatch.ROOT / "bin" / "crewbench_dispatch.py"),
         "--role", "developer", "--cli", "claude", "--model", "m", "--effort", "none",
         "--handoff", str(handoff), "--timeout", "2"],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=30,
    )
    elapsed = time.time() - start

    # One shared deadline: should finish close to --timeout + the grace kill
    # window, not the old `timeout + 60` per attempt.
    assert elapsed < 20, f"took {elapsed:.1f}s — deadline/kill logic regressed"

    envelope = json.loads(proc.stdout)
    assert envelope["ok"] is False
    assert "timed out" in envelope["error"]

    assert child_pid_file.exists(), "fake CLI never got to spawn its child"
    child_pid = int(child_pid_file.read_text())
    # Give the OS a moment to finish reaping after the group kill.
    for _ in range(20):
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.5)
    else:
        pytest.fail("grandchild process survived the timeout — orphaned")
