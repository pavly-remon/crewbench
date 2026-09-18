#!/usr/bin/env python3
"""Shared file-locking helpers for the `.crewbench/` on-disk contract.

Both crewbench_state.py (state.json/index.json) and crewbench_dispatch.py
(status.json) need the same exclusive-lock-around-read-modify-write pattern
so concurrent writers (e.g. a tester run and a reviewer run finishing at
the same time) never lose an update. This module is the single place that
pattern lives, so neither script has to import from the other.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1


def now_iso():
    """UTC ISO-8601 with an explicit offset, e.g. "2026-09-18T14:03:22Z".
    Every structured timestamp written anywhere in `.crewbench/` uses this
    (human-facing log-line prefixes may keep a short local-time format
    instead -- see crewbench_dispatch.py's now())."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_legacy_or_utc(ts):
    """Parse a timestamp written by either this UTC format or the old naive
    local-time one ("%Y-%m-%dT%H:%M:%S", no offset) that earlier versions of
    crewbench_state.py/crewbench_dispatch.py wrote. Returns a comparable,
    timezone-aware datetime, treating a naive value as local time. Returns
    None for anything unparseable (missing/malformed field) rather than
    raising -- callers should treat that as "unknown", not fail the read."""
    if not ts or not isinstance(ts, str):
        return None
    try:
        if ts.endswith("Z"):
            return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S").astimezone()
    except ValueError:
        return None


def _lock_file(handle):
    """Take an exclusive lock on an open file handle. POSIX uses fcntl, Windows msvcrt.

    Imported lazily so the module loads on platforms missing the other's lock module.
    """
    import os
    if os.name == "nt":
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
    else:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_EX)


def _unlock_file(handle):
    import os
    if os.name == "nt":
        import msvcrt
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    # POSIX: fcntl locks release automatically when the file descriptor closes.


def locked_read_modify_write(lock_path, mutate_fn):
    """Hold one exclusive lock across a full read -> mutate -> write cycle
    against `lock_path`'s sibling files, so no other locked_read_modify_write
    call against the same lock file can interleave.

    `mutate_fn` does the actual read/write work (it may touch several files,
    e.g. state.json and index.json together) and is called once, with the
    lock already held. Its return value is passed back to the caller.
    """
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w", encoding="utf-8") as lock:
        _lock_file(lock)
        try:
            return mutate_fn()
        finally:
            _unlock_file(lock)


def atomic_write_json(path, data):
    """Write `data` as JSON to `path` atomically (write to a temp file, then
    rename). Does not itself lock -- call this from inside
    locked_read_modify_write when concurrent writers are possible."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def read_json_or_default(path, default):
    path = Path(path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


EVENTS_FORMAT_VERSION = 1


def _events_path(task_dir):
    return Path(task_dir) / "events.jsonl"


def _events_lock_path(task_dir):
    return Path(task_dir) / ".events.lock"


def _last_seq(events_path):
    """The last line's `seq`, or 0 if the file is empty/missing/unreadable.
    Reads the whole file rather than keeping a separate counter file --
    one less thing that could desync from the log itself. Per-task event
    logs are small (hundreds of lines, not millions), so this is cheap in
    practice; documented in docs/app/contract/events.md as a known
    O(events-so-far) cost per append."""
    if not events_path.exists():
        return 0
    last_seq = 0
    with open(events_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                last_seq = json.loads(line).get("seq", last_seq)
            except ValueError:
                continue  # a torn/partial last line from a crash mid-write; skip it, don't crash the reader
    return last_seq


def append_event(task_dir, event_type, data, run=None):
    """Append one line to <task_dir>/events.jsonl: `{ "v": 1, "ts", "seq",
    "type", "task_id", "run", "data" }`. Locks + reads the last seq under
    one critical section, so concurrent writers (e.g. a tester and a
    reviewer run finishing at once) never interleave partial lines or
    duplicate seq. See docs/app/contract/events.md for the event catalog."""
    task_dir = Path(task_dir)

    def critical_section():
        events_path = _events_path(task_dir)
        event = {
            "v": EVENTS_FORMAT_VERSION,
            "ts": now_iso(),
            "seq": _last_seq(events_path) + 1,
            "type": event_type,
            "task_id": task_dir.name,
            "run": run,
            "data": data,
        }
        events_path.parent.mkdir(parents=True, exist_ok=True)
        with open(events_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
        return event

    return locked_read_modify_write(_events_lock_path(task_dir), critical_section)
