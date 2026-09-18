import importlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
crewbench_state = importlib.import_module("crewbench_state")


def run_state(*args, cwd):
    result = subprocess.run(
        [sys.executable, str(Path(crewbench_state.__file__)), *args],
        cwd=cwd, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_make_slug_and_task_id():
    assert crewbench_state.make_slug("Fix the Login Redirect Bug!! Now") == "fix-the-login-redirect-bug"
    task_id = crewbench_state.make_task_id("hello world")
    parts = task_id.split("-")
    assert len(parts[0]) == 8  # YYYYMMDD
    assert task_id.startswith(f"{parts[0]}-{parts[1]}-hello-world-")
    suffix = parts[-1]
    assert len(suffix) == 4 and all(c in "0123456789abcdef" for c in suffix)


def test_make_task_id_is_collision_resistant_within_the_same_minute():
    # Two tasks started in the same minute with the same description used
    # to collide (id was just YYYYMMDD-HHMM-<slug>) and silently overwrite
    # each other's task directory.
    ids = {crewbench_state.make_task_id("hello world") for _ in range(200)}
    assert len(ids) == 200


def test_new_creates_state_with_expected_defaults(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "20260101-0000-x"
    state = run_state("new", "--task-dir", str(task_dir), "--id", "20260101-0000-x",
                       "--command", "new-task", "--title", "X", cwd=tmp_path)
    assert state["phase"] == "scoping"
    assert state["round"] == 0
    assert state["rounds"] == []
    assert state["jira_key"] is None
    assert (task_dir / "state.json").exists()


def test_new_stores_jira_key_when_given(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "20260101-0001-y"
    state = run_state("new", "--task-dir", str(task_dir), "--id", "20260101-0001-y",
                       "--command", "new-task", "--title", "Y", "--jira-key", "PROJ-123",
                       cwd=tmp_path)
    assert state["jira_key"] == "PROJ-123"


def test_set_and_get_nested_key(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t1"
    run_state("new", "--task-dir", str(task_dir), "--id", "t1", "--command", "test", "--title", "T",
              cwd=tmp_path)
    run_state("set", "--task-dir", str(task_dir), "--key", "phase", "--value", '"implementing"',
              cwd=tmp_path)
    run_state("set", "--task-dir", str(task_dir), "--key", "lineup.developer",
              "--value", '{"cli": "agy"}', cwd=tmp_path)
    got = run_state("get", "--task-dir", str(task_dir), "--key", "lineup.developer", cwd=tmp_path)
    assert got == {"cli": "agy"}
    whole = run_state("get", "--task-dir", str(task_dir), cwd=tmp_path)
    assert whole["phase"] == "implementing"


def test_append_creates_list_if_missing(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t2"
    run_state("new", "--task-dir", str(task_dir), "--id", "t2", "--command", "review", "--title", "T",
              cwd=tmp_path)
    run_state("append", "--task-dir", str(task_dir), "--key", "notes", "--value", '"first note"',
              cwd=tmp_path)
    state = run_state("append", "--task-dir", str(task_dir), "--key", "notes",
                       "--value", '"second note"', cwd=tmp_path)
    assert state["notes"] == ["first note", "second note"]


def test_index_json_updated_and_listed(tmp_path):
    root = tmp_path / ".crewbench"
    task_dir = root / "tasks" / "t3"
    run_state("new", "--task-dir", str(task_dir), "--id", "t3", "--command", "design", "--title", "Design X",
              cwd=tmp_path)
    index = json.loads((root / "index.json").read_text())
    assert index["t3"]["title"] == "Design X"
    listed = run_state("list", "--root", str(root), cwd=tmp_path)
    assert any(row["id"] == "t3" for row in listed)


def test_get_missing_state_errors(tmp_path):
    result = subprocess.run(
        [sys.executable, str(Path(crewbench_state.__file__)), "get", "--task-dir", str(tmp_path / "nope")],
        cwd=tmp_path, capture_output=True, text=True,
    )
    assert result.returncode != 0
