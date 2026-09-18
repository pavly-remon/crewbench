#!/usr/bin/env python3
"""Run deterministic project checks before the LLM tester (Phase 7.2 gate).

Usage:
  python3 <root>/bin/crewbench_gate.py --cwd <worktree-or-project-root> \
      --task-dir .crewbench/tasks/<task-id> --round <n> \
      [--project-json <path>] [--timeout <seconds-per-step>]

Runs, in order, whichever of format_check / lint / typecheck / test_changed
(falling back to test) has a non-null command in project.json's "commands"
(default: <cwd>/.crewbench/project.json — the committed profile, so it's
already present in a worktree checked out from a commit where it exists).
Any step with no configured command is skipped entirely. Stops at the first
failing step (its output is usually what the next step would fail on too,
and the developer only needs one fix list per round) rather than running
every step regardless.

Each step gets its own process group and a timeout (default 600s / 10 min):
on timeout it is killed the same way crewbench_dispatch.py kills a timed-out
role (SIGTERM, then SIGKILL after crewbench_dispatch.GRACEFUL_KILL_TIMEOUT
seconds if it hasn't exited). Output is captured to
<task-dir>/runs/gate-r<n>.log; a JSON summary goes to
<task-dir>/runs/gate-r<n>.result.json and stdout:

  { "ok": bool, "steps": [ { "name", "command", "exit_code", "duration_s",
                              "timed_out", "output_tail" }, ... ] }

`output_tail` is the last 200 lines of that step's combined stdout+stderr.
Exit code is 0 if every configured step passed (or none were configured),
1 otherwise.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crewbench_dispatch import _terminate_pid_group, _hard_kill_pid_group, GRACEFUL_KILL_TIMEOUT  # noqa: E402

MAX_TAIL_LINES = 200
DEFAULT_TIMEOUT = 600


def load_commands(project_json_path):
    try:
        data = json.loads(Path(project_json_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    commands = data.get("commands")
    return commands if isinstance(commands, dict) else {}


def steps_to_run(commands):
    """[(name, command)] in gate order; test_changed wins over test when
    both are configured, and the step is labelled after whichever was used."""
    steps = []
    for name in ("format_check", "lint", "typecheck"):
        cmd = commands.get(name)
        if cmd:
            steps.append((name, cmd))
    test_cmd = commands.get("test_changed") or commands.get("test")
    if test_cmd:
        label = "test_changed" if commands.get("test_changed") else "test"
        steps.append((label, test_cmd))
    return steps


def _split(command):
    # Two confirmed-live problems, both from picking one shlex posix mode
    # for the whole platform: posix=True treats backslash as an escape
    # character, mangling a Windows path (`C:\Users\...\python.exe`
    # collapses to `C:Users...python.exe`); posix=False preserves
    # backslashes correctly but also keeps the literal quote characters
    # around a quoted token (its job is re-lexing shell syntax, not
    # stripping quotes) -- so a quoted gate command's quotes got passed
    # straight through as part of one argument, e.g. `python -c "import
    # sys; sys.exit(1)"` ran as a harmless string-literal statement
    # instead of the intended code, silently "succeeding" with exit 0.
    # Fix: always tokenize with posix=False (keeps backslashes literal on
    # every platform), then manually strip one matching pair of quote
    # characters from each token -- gets both right everywhere.
    # VERIFY: on Windows, npm/npx/yarn etc. are usually .cmd shims that need
    # shell semantics subprocess.Popen(shell=False) doesn't provide; not
    # exercised on a real Windows machine, same precedent as other
    # POSIX-first, Windows-best-effort code in this repo (e.g. the lock
    # helper in crewbench_fs.py's _lock_file/_unlock_file).
    tokens = shlex.split(command, posix=False)
    return [t[1:-1] if len(t) >= 2 and t[0] == t[-1] and t[0] in ('"', "'") else t
            for t in tokens]


def run_step(name, command, cwd, timeout):
    popen_kwargs = {}
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs["start_new_session"] = True
    start = time.time()
    proc = subprocess.Popen(_split(command), cwd=cwd, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                            errors="replace", **popen_kwargs)
    timed_out = False
    try:
        output, _ = proc.communicate(timeout=timeout)
        exit_code = proc.returncode
    except subprocess.TimeoutExpired:
        timed_out = True
        _terminate_pid_group(proc.pid)
        try:
            output, _ = proc.communicate(timeout=GRACEFUL_KILL_TIMEOUT)
        except subprocess.TimeoutExpired:
            _hard_kill_pid_group(proc.pid)
            output, _ = proc.communicate()
        exit_code = None
    duration = round(time.time() - start, 1)
    output = output or ""
    tail = "\n".join(output.splitlines()[-MAX_TAIL_LINES:])
    return {
        "name": name, "command": command, "exit_code": exit_code,
        "duration_s": duration, "timed_out": timed_out, "output_tail": tail,
    }, output


def run_gate(cwd, task_dir, round_n, project_json_path, timeout):
    runs_dir = Path(task_dir) / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    commands = load_commands(project_json_path)
    steps = steps_to_run(commands)
    result = {"ok": True, "steps": []}
    log_path = runs_dir / f"gate-r{round_n}.log"
    with open(log_path, "w", encoding="utf-8") as log:
        if not steps:
            log.write("no gate commands configured in project.json — nothing to run\n")
        for name, command in steps:
            log.write(f"$ {command}\n")
            step_result, output = run_step(name, command, cwd, timeout)
            log.write(output)
            if output and not output.endswith("\n"):
                log.write("\n")
            status = "timed out" if step_result["timed_out"] else f"exit {step_result['exit_code']}"
            log.write(f"{status} after {step_result['duration_s']}s\n\n")
            result["steps"].append(step_result)
            if step_result["exit_code"] != 0:
                result["ok"] = False
                break
    result_path = runs_dir / f"gate-r{round_n}.result.json"
    result_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result, log_path, result_path


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cwd", required=True)
    p.add_argument("--task-dir", required=True)
    p.add_argument("--round", type=int, required=True)
    p.add_argument("--project-json", default=None,
                   help="default: <cwd>/.crewbench/project.json")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="seconds per step (default 600)")
    args = p.parse_args(argv)

    cwd = os.path.abspath(args.cwd)
    project_json_path = args.project_json or os.path.join(cwd, ".crewbench", "project.json")
    result, log_path, result_path = run_gate(cwd, args.task_dir, args.round, project_json_path, args.timeout)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main(sys.argv[1:])
