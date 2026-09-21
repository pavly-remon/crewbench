#!/usr/bin/env python3
"""Find a real, currently-running crewbench daemon on this machine, and
print the (tokenless) URL to open a task in it.

Phase 4 milestone 5's `/crewbench:open` skill needs this: the daemon's
own bearer token is never persisted anywhere (Phase 2's "never persisted"
security principle, unchanged by this milestone -- see
docs/app/phase-4-plan.md's Design decision 6), so this script can only
ever discover *where* a live daemon is, never authenticate to it. The
person still authenticates through whatever browser tab already holds the
token from when they ran `crewbench ui` themselves (the token lives in
that tab's `location.hash`).

Discovery order:
  1. `~/.crewbench/config.json`'s own `port` field, if set -- the
     daemon's own preferred port (`packages/daemon/src/config.ts`'s
     `DaemonConfigSchema`), read directly rather than guessed. `CREWBENCH_HOME`
     overrides where this file lives, same override every other
     crewbench-app lookup respects.
  2. If unset (or not reachable there), scan `4287..4287+49` -- the
     daemon's own real default port and `findOpenPort()`'s own
     `maxAttempts` window (`packages/daemon/src/port.ts`), so this script's
     search range matches what the daemon itself would actually try.

A port is confirmed to have a real crewbench daemon (not just anything
occupying it) by GETting its `/__crewbench_daemon__` liveness route --
the identical, unauthenticated, non-secret endpoint
`packages/daemon/src/singleton.ts` already added so one daemon process
can refuse to start a second instance -- and checking its
`{"marker": "crewbench-daemon"}` body, not just that something answered.

Usage:
  python3 <root>/bin/crewbench_daemon_probe.py [task-id]
      -> {"found": true, "port": 4287, "url": "http://127.0.0.1:4287/tasks/<id>"}
      -> {"found": false, "port": null, "url": null}
  With no task-id, "url" is just the daemon's own base URL.
Stdlib only.
"""
import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Optional

LIVENESS_MARKER = "crewbench-daemon"
DEFAULT_PORT = 4287
SCAN_ATTEMPTS = 50
TIMEOUT_S = 0.3


def daemon_home() -> Path:
    override = os.environ.get("CREWBENCH_HOME")
    if override:
        return Path(override)
    return Path.home() / ".crewbench"


def configured_port() -> Optional[int]:
    path = daemon_home() / "config.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    port = data.get("port")
    return port if isinstance(port, int) else None


def is_real_daemon(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/__crewbench_daemon__", timeout=TIMEOUT_S) as resp:
            if resp.status != 200:
                return False
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("marker") == LIVENESS_MARKER
    except Exception:
        return False


def find_daemon_port() -> Optional[int]:
    configured = configured_port()
    candidates = [configured] if configured is not None else list(range(DEFAULT_PORT, DEFAULT_PORT + SCAN_ATTEMPTS))
    for port in candidates:
        if is_real_daemon(port):
            return port
    return None


def main() -> int:
    task_id = sys.argv[1] if len(sys.argv) > 1 else None
    port = find_daemon_port()
    if port is None:
        print(json.dumps({"found": False, "port": None, "url": None}))
        return 0
    base = f"http://127.0.0.1:{port}"
    url = f"{base}/tasks/{task_id}" if task_id else base
    print(json.dumps({"found": True, "port": port, "url": url}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
