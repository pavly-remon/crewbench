"""Milestone 3 of docs/app/phase-0-plan.md: events.jsonl writer + emission
from crewbench_state.py, crewbench_dispatch.py and crewbench_gate.py."""
import importlib
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
crewbench_state = importlib.import_module("crewbench_state")
crewbench_fs = importlib.import_module("crewbench_fs")
crewbench_dispatch = importlib.import_module("crewbench_dispatch")


def run_state(*args, cwd):
    result = subprocess.run(
        [sys.executable, str(Path(crewbench_state.__file__)), *args],
        cwd=cwd, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def read_events(task_dir):
    path = Path(task_dir) / "events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# --- crewbench_state.py emission -------------------------------------------

def test_new_emits_task_created(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t1"
    run_state("new", "--task-dir", str(task_dir), "--id", "t1",
              "--command", "new-task", "--title", "T", "--jira-key", "PROJ-1", cwd=tmp_path)
    events = read_events(task_dir)
    assert [e["type"] for e in events] == ["task.created"]
    assert events[0]["data"] == {"command": "new-task", "title": "T", "jira_key": "PROJ-1"}
    assert events[0]["task_id"] == "t1"
    assert events[0]["seq"] == 1
    assert events[0]["v"] == 1


def test_set_phase_emits_phase_changed(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t2"
    run_state("new", "--task-dir", str(task_dir), "--id", "t2",
              "--command", "new-task", "--title", "T", cwd=tmp_path)
    run_state("set", "--task-dir", str(task_dir), "--key", "phase",
              "--value", '"implementing"', cwd=tmp_path)
    events = read_events(task_dir)
    phase_events = [e for e in events if e["type"] == "task.phase_changed"]
    assert len(phase_events) == 1
    assert phase_events[0]["data"] == {"from": "scoping", "to": "implementing"}


def test_set_phase_to_same_value_emits_no_event(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t3"
    run_state("new", "--task-dir", str(task_dir), "--id", "t3",
              "--command", "new-task", "--title", "T", cwd=tmp_path)
    run_state("set", "--task-dir", str(task_dir), "--key", "phase",
              "--value", '"scoping"', cwd=tmp_path)
    events = read_events(task_dir)
    assert not any(e["type"] == "task.phase_changed" for e in events)


def test_set_round_emits_round_started(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t4"
    run_state("new", "--task-dir", str(task_dir), "--id", "t4",
              "--command", "new-task", "--title", "T", cwd=tmp_path)
    run_state("set", "--task-dir", str(task_dir), "--key", "round", "--value", "1", cwd=tmp_path)
    events = read_events(task_dir)
    round_events = [e for e in events if e["type"] == "task.round_started"]
    assert round_events == [{"v": 1, "ts": round_events[0]["ts"], "seq": round_events[0]["seq"],
                              "type": "task.round_started", "task_id": "t4", "run": None,
                              "data": {"round": 1}}]


def test_append_notes_emits_note_added(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t5"
    run_state("new", "--task-dir", str(task_dir), "--id", "t5",
              "--command", "new-task", "--title", "T", cwd=tmp_path)
    run_state("append", "--task-dir", str(task_dir), "--key", "notes",
              "--value", '"hello"', cwd=tmp_path)
    events = read_events(task_dir)
    note_events = [e for e in events if e["type"] == "task.note_added"]
    assert note_events[0]["data"] == {"note": "hello"}


def test_set_unrelated_key_emits_no_state_event(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "t6"
    run_state("new", "--task-dir", str(task_dir), "--id", "t6",
              "--command", "new-task", "--title", "T", cwd=tmp_path)
    run_state("set", "--task-dir", str(task_dir), "--key", "lineup.developer",
              "--value", '{"cli": "agy"}', cwd=tmp_path)
    events = read_events(task_dir)
    assert [e["type"] for e in events] == ["task.created"]


# --- concurrency: no lost/interleaved/duplicate-seq events -----------------

def test_concurrent_appends_have_gapless_monotonic_seq(tmp_path):
    task_dir = tmp_path / ".crewbench" / "tasks" / "concurrent"
    task_dir.mkdir(parents=True)
    N = 16

    def emit(i):
        crewbench_fs.append_event(task_dir, "task.note_added", {"note": f"n{i}"})

    with ThreadPoolExecutor(max_workers=N) as pool:
        list(pool.map(emit, range(N)))

    events = read_events(task_dir)
    assert len(events) == N
    seqs = sorted(e["seq"] for e in events)
    assert seqs == list(range(1, N + 1)), "seq must be gapless, monotonic and unique"
    notes = {e["data"]["note"] for e in events}
    assert notes == {f"n{i}" for i in range(N)}, "an event was lost or a line was interleaved/corrupted"


# --- classify_log_entry ------------------------------------------------------

def test_classify_log_entry():
    assert crewbench_dispatch.classify_log_entry("says: hello") == "run.message"
    assert crewbench_dispatch.classify_log_entry("tool: Bash {'command': 'ls'}") == "run.tool_call"
    assert crewbench_dispatch.classify_log_entry("  error: boom") == "run.tool_error"
    # agy inline tool error: "tool: <name> <params>  -> <error message>"
    assert crewbench_dispatch.classify_log_entry("tool: Shell {}  -> denied") == "run.tool_error"
    assert crewbench_dispatch.classify_log_entry("session started (m) id=abc") == "run.message"


# --- crewbench_gate.py emission ---------------------------------------------

def test_gate_finished_emits_event(tmp_path, git_repo):
    task_dir = tmp_path / "task"
    crewbench_gate = importlib.import_module("crewbench_gate")
    subprocess.run(
        [sys.executable, str(Path(crewbench_gate.__file__)), "--cwd", str(git_repo),
         "--task-dir", str(task_dir), "--round", "2"],
        cwd=git_repo, capture_output=True, text=True,
    )
    events = read_events(task_dir)
    gate_events = [e for e in events if e["type"] == "gate.finished"]
    assert len(gate_events) == 1
    assert gate_events[0]["data"]["round"] == 2
    assert gate_events[0]["run"] is None


# --- crewbench_dispatch.py emission (real subprocess, fake CLI) ------------

def _dispatch_argv():
    return [sys.executable, str(crewbench_dispatch.ROOT / "bin" / "crewbench_dispatch.py")]


def test_dispatch_emits_started_message_and_finished_events(git_repo, fake_cli_dir):
    handoff = git_repo / "handoff.md"
    handoff.write_text("Task: anything\n")
    task_dir = git_repo / ".crewbench" / "tasks" / "t1"
    env = dict(os.environ)
    env["CREWBENCH_CLI_OVERRIDE_CLAUDE"] = str(fake_cli_dir / "quick_success.py")

    result = subprocess.run(
        _dispatch_argv() + ["--role", "developer", "--cli", "claude", "--model", "m",
                            "--effort", "none", "--task-dir", str(task_dir), "--round", "1",
                            "--handoff", str(handoff)],
        cwd=git_repo, env=env, capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    events = read_events(task_dir)
    types = [e["type"] for e in events]
    assert types[0] == "run.started"
    assert types[-1] == "run.finished"
    assert all(e["run"] == "developer-r1" for e in events)
    seqs = [e["seq"] for e in events]
    assert seqs == list(range(1, len(events) + 1))
    finished = events[-1]
    assert finished["data"]["ok"] is True
