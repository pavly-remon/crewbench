#!/usr/bin/env python3
"""Read/write a crewbench task's `state.json`, and keep `.crewbench/index.json`
in sync. Stdlib only. See lib/dispatch.md for the state.json field reference
and schemas/task-state.json for its shape.

Layout assumed: <root>/tasks/<task-id>/state.json, with the task-level index
at <root>/index.json (`<root>` is normally `.crewbench`).

Usage:
  crewbench_state.py slug "task description"
      -> prints a task id: YYYYMMDD-HHMM-<up-to-5-word-kebab-slug>

  crewbench_state.py new --task-dir <dir> --id <id> --command <cmd> --title <title>
                          [--base-commit <sha>] [--branch <name>]
      -> creates state.json with the initial fields (phase: scoping)

  crewbench_state.py get --task-dir <dir> [--key <dotted.key>]
      -> prints the whole state (or just the value at --key) as JSON

  crewbench_state.py set --task-dir <dir> --key <dotted.key> --value <json>
      -> sets a (possibly nested) field; creates intermediate dicts as needed

  crewbench_state.py append --task-dir <dir> --key <dotted.key> --value <json>
      -> appends to a list field, creating it if missing

  crewbench_state.py list [--root <dir>]
      -> prints .crewbench/index.json (default root: ./.crewbench), newest first
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crewbench_dispatch import _lock_file, _unlock_file  # noqa: E402


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def make_slug(text, max_words=5):
    words = re.findall(r"[A-Za-z0-9]+", text.lower())[:max_words]
    return "-".join(words) or "task"


def make_task_id(text):
    return f"{time.strftime('%Y%m%d-%H%M')}-{make_slug(text)}"


def _atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.parent / f".{path.name}.lock"
    with open(lock_path, "w") as lock:
        _lock_file(lock)
        try:
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2) + "\n")
            tmp.replace(path)
        finally:
            _unlock_file(lock)


def _index_path(task_dir):
    # <root>/tasks/<id> -> <root>/index.json
    return task_dir.parent.parent / "index.json"


def _update_index(task_dir, state):
    index_path = _index_path(task_dir)
    try:
        index = json.loads(index_path.read_text())
    except (OSError, ValueError):
        index = {}
    index[state["id"]] = {
        "id": state["id"], "command": state.get("command"), "title": state.get("title"),
        "phase": state.get("phase"), "round": state.get("round"),
        "updated_at": state.get("updated_at"),
    }
    _atomic_write(index_path, index)


def _state_path(task_dir):
    return task_dir / "state.json"


def load_state(task_dir):
    path = _state_path(task_dir)
    if not path.exists():
        raise SystemExit(f"no state.json in {task_dir} — run `new` first")
    return json.loads(path.read_text())


def save_state(task_dir, state):
    state["updated_at"] = now_iso()
    _atomic_write(_state_path(task_dir), state)
    _update_index(task_dir, state)


def get_at(data, dotted):
    cur = data
    for part in dotted.split("."):
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    return cur


def set_at(data, dotted, value):
    parts = dotted.split(".")
    cur = data
    for part in parts[:-1]:
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur.setdefault(part, {})
    last = parts[-1]
    if isinstance(cur, list):
        cur[int(last)] = value
    else:
        cur[last] = value


def append_at(data, dotted, value):
    parts = dotted.split(".")
    cur = data
    for part in parts[:-1]:
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur.setdefault(part, {})
    last = parts[-1]
    if last not in cur or not isinstance(cur[last], list):
        cur[last] = []
    cur[last].append(value)


def cmd_slug(args):
    print(make_task_id(args.text))


def cmd_new(args):
    task_dir = Path(args.task_dir)
    state = {
        "id": args.id,
        "command": args.command,
        "title": args.title,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "phase": "scoping",
        "round": 0,
        "lineup": {},
        "base_commit": args.base_commit,
        "branch": args.branch,
        "worktree": None,
        "host_override": None,
        "doctor": {},
        "acceptance_criteria": [],
        "design_spec_file": args.design_spec_file,
        "rounds": [],
        "usage": {},
        "notes": [],
    }
    save_state(task_dir, state)
    print(json.dumps(state, indent=2))


def cmd_get(args):
    state = load_state(Path(args.task_dir))
    print(json.dumps(get_at(state, args.key) if args.key else state, indent=2))


def cmd_set(args):
    task_dir = Path(args.task_dir)
    state = load_state(task_dir)
    set_at(state, args.key, json.loads(args.value))
    save_state(task_dir, state)
    print(json.dumps(state, indent=2))


def cmd_append(args):
    task_dir = Path(args.task_dir)
    state = load_state(task_dir)
    append_at(state, args.key, json.loads(args.value))
    save_state(task_dir, state)
    print(json.dumps(state, indent=2))


def cmd_list(args):
    index_path = Path(args.root) / "index.json"
    try:
        index = json.loads(index_path.read_text())
    except (OSError, ValueError):
        index = {}
    rows = sorted(index.values(), key=lambda r: r.get("updated_at") or "", reverse=True)
    print(json.dumps(rows, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("slug")
    s.add_argument("text")
    s.set_defaults(func=cmd_slug)

    s = sub.add_parser("new")
    s.add_argument("--task-dir", required=True)
    s.add_argument("--id", required=True)
    s.add_argument("--command", required=True, choices=["new-task", "test", "review", "design"])
    s.add_argument("--title", required=True)
    s.add_argument("--base-commit", default=None)
    s.add_argument("--branch", default=None)
    s.add_argument("--design-spec-file", default=None)
    s.set_defaults(func=cmd_new)

    s = sub.add_parser("get")
    s.add_argument("--task-dir", required=True)
    s.add_argument("--key", default=None)
    s.set_defaults(func=cmd_get)

    s = sub.add_parser("set")
    s.add_argument("--task-dir", required=True)
    s.add_argument("--key", required=True)
    s.add_argument("--value", required=True, help="JSON value")
    s.set_defaults(func=cmd_set)

    s = sub.add_parser("append")
    s.add_argument("--task-dir", required=True)
    s.add_argument("--key", required=True)
    s.add_argument("--value", required=True, help="JSON value to append")
    s.set_defaults(func=cmd_append)

    s = sub.add_parser("list")
    s.add_argument("--root", default=".crewbench")
    s.set_defaults(func=cmd_list)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
