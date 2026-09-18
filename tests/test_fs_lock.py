"""Concurrency tests for the shared lock helpers in crewbench_fs.py, proving
that concurrent crewbench_state.py `set`/`append` calls against the same
task never lose an update to state.json or index.json (see
docs/app/phase-0-plan.md, milestone 1)."""
import importlib
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
crewbench_state = importlib.import_module("crewbench_state")

N = 12


def run_state(*args, cwd):
    result = subprocess.run(
        [sys.executable, str(Path(crewbench_state.__file__)), *args],
        cwd=cwd, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_concurrent_set_calls_lose_no_update(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "concurrent-set"
    run_state("new", "--task-dir", str(task_dir), "--id", "concurrent-set",
              "--command", "new-task", "--title", "T", cwd=tmp_path)

    def set_one(i):
        run_state("set", "--task-dir", str(task_dir), "--key", f"notes.{i}" if False else f"field{i}",
                  "--value", json.dumps(i), cwd=tmp_path)

    with ThreadPoolExecutor(max_workers=N) as pool:
        list(pool.map(set_one, range(N)))

    state = run_state("get", "--task-dir", str(task_dir), cwd=tmp_path)
    for i in range(N):
        assert state[f"field{i}"] == i, f"field{i} missing or wrong — a concurrent write was lost"


def test_concurrent_append_calls_lose_no_update(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "concurrent-append"
    run_state("new", "--task-dir", str(task_dir), "--id", "concurrent-append",
              "--command", "new-task", "--title", "T", cwd=tmp_path)

    def append_one(i):
        run_state("append", "--task-dir", str(task_dir), "--key", "notes",
                  "--value", json.dumps(f"note-{i}"), cwd=tmp_path)

    with ThreadPoolExecutor(max_workers=N) as pool:
        list(pool.map(append_one, range(N)))

    state = run_state("get", "--task-dir", str(task_dir), cwd=tmp_path)
    assert sorted(state["notes"]) == sorted(f"note-{i}" for i in range(N)), \
        "a concurrent append was lost or duplicated"


def test_concurrent_writes_to_different_tasks_all_land_in_index(tmp_path):
    root = tmp_path / ".crewbench"

    def new_task(i):
        task_id = f"task-{i}"
        run_state("new", "--task-dir", str(root / "tasks" / task_id), "--id", task_id,
                   "--command", "new-task", "--title", f"Task {i}", cwd=tmp_path)

    with ThreadPoolExecutor(max_workers=N) as pool:
        list(pool.map(new_task, range(N)))

    index = json.loads((root / "index.json").read_text(encoding="utf-8"))
    for i in range(N):
        assert f"task-{i}" in index, f"task-{i} missing from index.json — a concurrent index write was lost"
