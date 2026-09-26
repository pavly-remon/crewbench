"""Milestone 2 of docs/app/phase-0-plan.md: UTC timestamps, collision-proof
task ids, and schema_version (with legacy reads)."""
import importlib
import json
import re
import subprocess
import sys
from datetime import timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
crewbench_state = importlib.import_module("crewbench_state")
crewbench_fs = importlib.import_module("crewbench_fs")

UTC_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def run_state(*args, cwd):
    result = subprocess.run(
        [sys.executable, str(Path(crewbench_state.__file__)), *args],
        cwd=cwd, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_now_iso_is_utc_with_explicit_offset():
    ts = crewbench_fs.now_iso()
    assert UTC_TS_RE.match(ts), f"{ts!r} is not UTC ISO-8601 with an explicit Z offset"


def test_new_task_state_has_utc_timestamps_and_schema_version(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t1"
    state = run_state("new", "--task-dir", str(task_dir), "--id", "t1",
                       "--command", "new-task", "--title", "T", cwd=tmp_path)
    assert state["schema_version"] == crewbench_fs.SCHEMA_VERSION
    assert UTC_TS_RE.match(state["created_at"])
    assert UTC_TS_RE.match(state["updated_at"])

    index = json.loads((tmp_path / ".crewbench" / "index.json").read_text())
    assert index["t1"]["schema_version"] == crewbench_fs.SCHEMA_VERSION


def test_legacy_state_missing_schema_version_still_reads(tmp_path):
    # Simulate a state.json written before this field existed: no
    # schema_version, naive local timestamp.
    task_dir = tmp_path / ".crewbench" / "tasks" / "legacy"
    task_dir.mkdir(parents=True)
    legacy_state = {
        "id": "legacy", "command": "new-task", "title": "Legacy",
        "created_at": "2025-01-01T00:00:00", "updated_at": "2025-01-01T00:00:00",
        "phase": "done", "round": 1, "lineup": {}, "base_commit": None, "branch": None,
        "worktree": None, "acceptance_criteria": [], "design_spec_file": None,
        "rounds": [], "usage": {}, "notes": [],
    }
    (task_dir / "state.json").write_text(json.dumps(legacy_state), encoding="utf-8")

    got = run_state("get", "--task-dir", str(task_dir), cwd=tmp_path)
    assert "schema_version" not in got or got.get("schema_version") is None
    assert got["phase"] == "done"

    # A subsequent `set` against a legacy task must still work (no crash on
    # a missing schema_version) and produces a current, versioned entry.
    updated = run_state("set", "--task-dir", str(task_dir), "--key", "phase",
                         "--value", '"stopped"', cwd=tmp_path)
    assert updated["phase"] == "stopped"


def test_parse_legacy_or_utc_handles_both_formats():
    utc = crewbench_fs.parse_legacy_or_utc("2026-09-18T14:03:22Z")
    assert utc.tzinfo is not None and utc.utcoffset().total_seconds() == 0

    legacy = crewbench_fs.parse_legacy_or_utc("2025-01-01T00:00:00")
    assert legacy.tzinfo is not None  # treated as local time, but comparable

    assert crewbench_fs.parse_legacy_or_utc(None) is None
    assert crewbench_fs.parse_legacy_or_utc("not-a-timestamp") is None


def test_list_sorts_legacy_and_utc_timestamps_correctly(tmp_path):
    root = tmp_path / ".crewbench"
    (root).mkdir(parents=True)
    index = {
        "old": {"id": "old", "title": "Old", "updated_at": "2020-01-01T00:00:00"},
        "new": {"id": "new", "title": "New", "updated_at": crewbench_fs.now_iso()},
        "broken": {"id": "broken", "title": "Broken", "updated_at": "garbage"},
    }
    (root / "index.json").write_text(json.dumps(index), encoding="utf-8")
    rows = run_state("list", "--root", str(root), cwd=tmp_path)
    ids = [r["id"] for r in rows]
    assert ids.index("new") < ids.index("old") < ids.index("broken")


def test_two_ids_from_same_text_in_same_minute_do_not_collide():
    a = crewbench_state.make_task_id("hello world")
    b = crewbench_state.make_task_id("hello world")
    assert a != b
