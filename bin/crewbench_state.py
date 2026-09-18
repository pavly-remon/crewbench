#!/usr/bin/env python3
"""Read/write a crewbench task's `state.json`, and keep `.crewbench/index.json`
in sync. Stdlib only. See lib/dispatch.md for the state.json field reference
and schemas/task-state.json for its shape.

Layout assumed: <root>/tasks/<task-id>/state.json, with the task-level index
at <root>/index.json (`<root>` is normally `.crewbench`).

Usage:
  crewbench_state.py slug "task description"
      -> prints a task id: YYYYMMDD-HHMM-<up-to-5-word-kebab-slug>-<4 hex>
         (the hex suffix only guards against two tasks started in the same
         minute with a similar description; older ids without it still
         work everywhere else in this script)

  crewbench_state.py new --task-dir <dir> --id <id> --command <cmd> --title <title>
                          [--base-commit <sha>] [--branch <name>]
                          [--design-spec-file <path>] [--jira-key <key>]
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
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crewbench_fs import (  # noqa: E402
    SCHEMA_VERSION, atomic_write_json, locked_read_modify_write, now_iso, parse_legacy_or_utc,
    read_json_or_default,
)


def make_slug(text, max_words=5):
    words = re.findall(r"[A-Za-z0-9]+", text.lower())[:max_words]
    return "-".join(words) or "task"


def make_task_id(text):
    return f"{time.strftime('%Y%m%d-%H%M')}-{make_slug(text)}-{secrets.token_hex(2)}"


def _index_path(task_dir):
    # <root>/tasks/<id> -> <root>/index.json
    return task_dir.parent.parent / "index.json"


def _index_entry(state):
    return {
        "schema_version": state.get("schema_version", SCHEMA_VERSION),
        "id": state["id"], "command": state.get("command"), "title": state.get("title"),
        "phase": state.get("phase"), "round": state.get("round"),
        "updated_at": state.get("updated_at"),
    }


def _state_path(task_dir):
    return task_dir / "state.json"


def _state_lock_path(task_dir):
    return task_dir / ".state.json.lock"


def _index_lock_path(task_dir):
    # One lock file per .crewbench root, shared by every task under it —
    # index.json itself is shared, unlike state.json which is per-task.
    return _index_path(task_dir).parent / ".index.json.lock"


def load_state(task_dir):
    path = _state_path(task_dir)
    if not path.exists():
        raise SystemExit(f"no state.json in {task_dir} — run `new` first")
    return json.loads(path.read_text(encoding="utf-8"))


def mutate_state(task_dir, mutate_fn):
    """Hold locks across load -> mutate -> save for both state.json and
    index.json, so concurrent `set`/`append`/`new` calls never lose an
    update to either file — whether they race on the *same* task (e.g. a
    tester run and a reviewer run finishing at once, serialized by the
    per-task state lock) or on *different* tasks under the same root
    racing on the shared index.json (serialized by the index lock).
    `mutate_fn(state_or_None) -> state` does the actual field change; it
    receives None when state.json doesn't exist yet (the `new` case).

    Lock order is always state-lock-then-index-lock, so two tasks can never
    deadlock on each other (each task's state lock is a different file;
    only the index lock is shared, and it's always acquired last)."""
    def update_index_and_save(state):
        def critical_section():
            atomic_write_json(_state_path(task_dir), state)
            index_path = _index_path(task_dir)
            index = read_json_or_default(index_path, {})
            index[state["id"]] = _index_entry(state)
            atomic_write_json(index_path, index)
            return state

        return locked_read_modify_write(_index_lock_path(task_dir), critical_section)

    def critical_section():
        path = _state_path(task_dir)
        state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        state = mutate_fn(state)
        state["updated_at"] = now_iso()
        return update_index_and_save(state)

    return locked_read_modify_write(_state_lock_path(task_dir), critical_section)


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

    def build(existing):
        return {
            "schema_version": SCHEMA_VERSION,
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
            "jira_key": args.jira_key,
            "host_override": None,
            "doctor": {},
            "acceptance_criteria": [],
            "design_spec_file": args.design_spec_file,
            "rounds": [],
            "usage": {},
            "notes": [],
        }

    state = mutate_state(task_dir, build)
    print(json.dumps(state, indent=2))


def cmd_get(args):
    state = load_state(Path(args.task_dir))
    print(json.dumps(get_at(state, args.key) if args.key else state, indent=2))


def cmd_set(args):
    task_dir = Path(args.task_dir)
    value = json.loads(args.value)

    def mutate(state):
        if state is None:
            raise SystemExit(f"no state.json in {task_dir} — run `new` first")
        set_at(state, args.key, value)
        return state

    state = mutate_state(task_dir, mutate)
    print(json.dumps(state, indent=2))


def cmd_append(args):
    task_dir = Path(args.task_dir)
    value = json.loads(args.value)

    def mutate(state):
        if state is None:
            raise SystemExit(f"no state.json in {task_dir} — run `new` first")
        append_at(state, args.key, value)
        return state

    state = mutate_state(task_dir, mutate)
    print(json.dumps(state, indent=2))


def cmd_list(args):
    index_path = Path(args.root) / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {}
    # Sort by parsed time (not the raw string) so old naive-local timestamps
    # and new UTC ones compare correctly against each other; unparseable/
    # missing timestamps sort last regardless of direction.
    def sort_key(row):
        parsed = parse_legacy_or_utc(row.get("updated_at"))
        return parsed or datetime.min.replace(tzinfo=timezone.utc)

    rows = sorted(index.values(), key=sort_key, reverse=True)
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
    s.add_argument("--jira-key", default=None)
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
