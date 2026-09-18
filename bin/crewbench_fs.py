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
