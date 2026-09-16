import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
crewbench_gate = importlib.import_module("crewbench_gate")


def run_gate(cwd, task_dir, round_n=1, extra_args=()):
    result = subprocess.run(
        [sys.executable, str(Path(crewbench_gate.__file__)),
         "--cwd", str(cwd), "--task-dir", str(task_dir), "--round", str(round_n), *extra_args],
        capture_output=True, text=True,
    )
    return result


def write_project_json(cwd, commands):
    (cwd / ".crewbench").mkdir(parents=True, exist_ok=True)
    (cwd / ".crewbench" / "project.json").write_text(json.dumps({"commands": commands}))


def test_no_commands_configured_is_ok_and_empty(tmp_path):
    write_project_json(tmp_path, {})
    task_dir = tmp_path / "task"
    result = run_gate(tmp_path, task_dir)
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data == {"ok": True, "steps": []}
    assert (task_dir / "runs" / "gate-r1.result.json").exists()
    log = (task_dir / "runs" / "gate-r1.log").read_text()
    assert "nothing to run" in log


def test_runs_configured_steps_in_order_and_passes(tmp_path):
    write_project_json(tmp_path, {
        "lint": f"{sys.executable} -c \"print('lint ok')\"",
        "test": f"{sys.executable} -c \"print('test ok')\"",
    })
    task_dir = tmp_path / "task"
    result = run_gate(tmp_path, task_dir)
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["ok"] is True
    assert [s["name"] for s in data["steps"]] == ["lint", "test"]
    assert all(s["exit_code"] == 0 for s in data["steps"])


def test_test_changed_preferred_over_test(tmp_path):
    write_project_json(tmp_path, {
        "test": f"{sys.executable} -c \"import sys; sys.exit(1)\"",
        "test_changed": f"{sys.executable} -c \"import sys; sys.exit(0)\"",
    })
    task_dir = tmp_path / "task"
    result = run_gate(tmp_path, task_dir)
    data = json.loads(result.stdout)
    assert result.returncode == 0
    assert data["steps"][0]["name"] == "test_changed"
    assert data["steps"][0]["exit_code"] == 0


def test_stops_at_first_failing_step(tmp_path):
    write_project_json(tmp_path, {
        "format_check": f"{sys.executable} -c \"import sys; sys.exit(1)\"",
        "lint": f"{sys.executable} -c \"print('should not run')\"",
    })
    task_dir = tmp_path / "task"
    result = run_gate(tmp_path, task_dir)
    assert result.returncode == 1
    data = json.loads(result.stdout)
    assert data["ok"] is False
    assert [s["name"] for s in data["steps"]] == ["format_check"]


def test_output_tail_captured_on_failure(tmp_path):
    write_project_json(tmp_path, {
        "lint": f"{sys.executable} -c \"print('boom'); import sys; sys.exit(2)\"",
    })
    task_dir = tmp_path / "task"
    result = run_gate(tmp_path, task_dir)
    data = json.loads(result.stdout)
    assert data["steps"][0]["exit_code"] == 2
    assert "boom" in data["steps"][0]["output_tail"]


@pytest.mark.skipif(os.name == "nt", reason="process-group kill test targets POSIX")
def test_timeout_kills_process_group_and_marks_timed_out(tmp_path):
    write_project_json(tmp_path, {
        "lint": f"{sys.executable} -c \"import time; time.sleep(30)\"",
    })
    task_dir = tmp_path / "task"
    result = run_gate(tmp_path, task_dir, extra_args=["--timeout", "1"])
    assert result.returncode == 1
    data = json.loads(result.stdout)
    step = data["steps"][0]
    assert step["timed_out"] is True
    assert step["exit_code"] is None
    assert step["duration_s"] < 10


def test_project_json_override_path(tmp_path):
    other = tmp_path / "elsewhere.json"
    other.write_text(json.dumps({"commands": {"lint": f"{sys.executable} -c \"print(1)\""}}))
    task_dir = tmp_path / "task"
    result = run_gate(tmp_path, task_dir, extra_args=["--project-json", str(other)])
    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert data["steps"][0]["name"] == "lint"


def test_steps_to_run_skips_unconfigured():
    steps = crewbench_gate.steps_to_run({"lint": "eslint .", "typecheck": None, "test": None})
    assert steps == [("lint", "eslint .")]
