#!/usr/bin/env python3
"""Fake CLI used by test_deadline.py: ignores its argv entirely (the real
CLIs' flags differ too much to fake generically) and, driven by env vars,
optionally records its own pid, spawns a child that outlives a naive
proc.kill(), and sleeps well past the test's --timeout so the run always
times out. Proves crewbench_dispatch kills the whole process group.
"""
import os
import pathlib
import subprocess
import sys
import time

pid_file = os.environ.get("FAKE_CLI_PID_FILE")
child_pid_file = os.environ.get("FAKE_CLI_CHILD_PID_FILE")
sleep_s = float(os.environ.get("FAKE_CLI_SLEEP", "30"))

if pid_file:
    pathlib.Path(pid_file).write_text(str(os.getpid()))

if child_pid_file:
    child = subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({sleep_s})"])
    pathlib.Path(child_pid_file).write_text(str(child.pid))

time.sleep(sleep_s)
