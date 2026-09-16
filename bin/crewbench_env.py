#!/usr/bin/env python3
"""Detect which CLI host crewbench is running under, and resolve the plugin root.

Usage:
  python3 <root>/bin/crewbench_env.py whoami
      -> {"host": ..., "plugin_root": ..., "python": ..., "platform": ..., "config_dir": ...}

Host detection, in order:
  1. CREWBENCH_HOST_OVERRIDE env var, if set to a known host -- lets a test or
     a user who was asked once (see lib/dispatch.md) force the answer.
  2. CLAUDECODE=1 -- Claude Code's own confirmed marker: present in this
     process's environment while actually running inside Claude Code (checked
     directly, not from documentation).
  3. A parent-process-name walk (POSIX only, via `ps`) looking for `codex`,
     `agy` or `copilot` among this process's ancestors.

No equivalent "I am running inside <cli>" environment variable was found
documented for codex, agy or copilot (`codex --help`, `agy --help`, `copilot
help environment`, as of writing) -- VERIFY if a future version adds one; step
3 is the fallback for all three. On Windows, step 3 can't walk ancestors
without a non-stdlib dependency, so detection there relies on steps 1-2 only
-- VERIFY / untested on Windows.

If nothing matches, host is "unknown" and the caller (the Team Lead) should
ask the user once and record `host_override` in the task's state.json rather
than guessing every time (see lib/dispatch.md "Host detection").

Usage:
  python3 <root>/bin/crewbench_env.py check-model --cli <cli> --model <model>
      -> { "cli", "model", "checked", "found", "closest": [...],
           "available": [...], "error" }
      Only "agy" has a discovered model-listing command (`agy models`) as
      of writing -- checked `claude --help`, `codex --help` and `copilot
      help commands` and found no equivalent for any of the three, so
      "checked" is false and "error" explains why for those CLIs (see
      lib/dispatch.md's "Model name freshness" section).
"""
import difflib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWN_HOSTS = ("claude", "codex", "agy", "copilot")

# Real, per-host crewbench plugin-cache locations, confirmed by installing
# crewbench under all four CLIs on one development machine (agy's cache has
# no version subdirectory; claude/codex do). copilot's is a best-effort
# pattern from `copilot plugin --help`'s described layout -- VERIFY, since no
# copilot crewbench install existed to inspect when this was written.
PLUGIN_ROOT_GLOBS = {
    "claude": ["~/.claude/plugins/cache/*/crewbench/*"],
    "codex": ["~/.codex/plugins/cache/*/crewbench/*"],
    "agy": ["~/.gemini/config/plugins/crewbench"],
    "copilot": ["~/.copilot/installed-plugins/*/crewbench*",
                "~/.copilot/installed-plugins/crewbench*"],  # VERIFY: unconfirmed layout
}

# Each CLI's config/credentials directory. codex and copilot support an env
# override (confirmed: `codex exec --help`'s "auth still uses CODEX_HOME";
# `copilot help environment`'s COPILOT_HOME entry); claude and agy have no
# documented override as of writing.
CONFIG_DIRS = {
    "claude": "~/.claude",
    "codex": os.environ.get("CODEX_HOME") or "~/.codex",
    "agy": "~/.gemini",
    "copilot": os.environ.get("COPILOT_HOME") or "~/.copilot",
}


def _ppid(pid):
    try:
        r = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)],
                            capture_output=True, text=True, timeout=2)
        value = r.stdout.strip()
        return int(value) if value.isdigit() else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _proc_name(pid):
    try:
        r = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)],
                            capture_output=True, text=True, timeout=2)
        name = r.stdout.strip()
        return name.rsplit("/", 1)[-1] if name else None
    except (OSError, subprocess.SubprocessError):
        return None


def parent_chain(max_depth=10):
    """Ancestor process names, nearest first. POSIX only (shells out to `ps`
    repeatedly, since the stdlib has no ancestor-walk); returns [] on Windows
    or if `ps` isn't available. Callers must treat an empty chain as
    "undetermined", not "no host matched"."""
    if os.name == "nt":
        return []
    names = []
    pid = os.getpid()
    for _ in range(max_depth):
        ppid = _ppid(pid)
        if not ppid or ppid == pid or ppid <= 1:
            break
        name = _proc_name(ppid)
        if name:
            names.append(name)
        pid = ppid
    return names


def detect_host(chain=None):
    override = os.environ.get("CREWBENCH_HOST_OVERRIDE")
    if override in KNOWN_HOSTS:
        return override
    if os.environ.get("CLAUDECODE") == "1":
        return "claude"
    chain = parent_chain() if chain is None else chain
    for name in chain:
        if name in ("codex", "agy", "copilot"):
            return name
    return "unknown"


def resolve_plugin_root():
    """Placeholder expanded -> env var -> this script's own install location.

    `CLAUDE_PLUGIN_ROOT` covers hosts that expand the placeholder or set the
    env var themselves. Beyond that, this script's own file path is always
    correct: it only runs from inside an installed crewbench's `bin/`, so
    `parent.parent` of this file *is* `<root>`, regardless of host -- no
    search of `PLUGIN_ROOT_GLOBS` is needed for the script's own purposes.
    Those globs exist for `lib/dispatch.md` to document as a fallback for the
    Team Lead (an LLM reading a skill file), which faces the real version of
    this problem: finding `<root>` *before* it can invoke this script.
    """
    override = os.environ.get("CREWBENCH_PLUGIN_ROOT")
    if override and Path(override).is_dir():
        return override
    placeholder = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if placeholder and Path(placeholder).is_dir():
        return placeholder
    return str(ROOT)


def whoami():
    host = detect_host()
    config_dir = CONFIG_DIRS.get(host)
    return {
        "host": host,
        "plugin_root": resolve_plugin_root(),
        "python": sys.executable,
        "platform": sys.platform,
        "config_dir": os.path.expanduser(config_dir) if config_dir else None,
    }


# Model-listing command per CLI, argv after the CLI's own path. VERIFY:
# only agy's was confirmed (`agy models`, real output inspected on this
# machine); `claude --help`, `codex --help` and `copilot help commands`
# were all checked and show no equivalent -- corrects an earlier
# assumption (see CHECKPOINT.md) that claude had one too.
MODEL_LIST_COMMANDS = {"agy": ["models"]}


def list_models(cli, cli_path):
    """(model_ids, error). model_ids is None (with error set) when this CLI
    has no known model-listing command or the call itself failed."""
    if cli not in MODEL_LIST_COMMANDS:
        return None, f"no model-listing command is known for {cli} (see MODEL_LIST_COMMANDS)"
    try:
        r = subprocess.run([cli_path, *MODEL_LIST_COMMANDS[cli]],
                            capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, str(exc)
    if r.returncode != 0:
        return None, (r.stderr or r.stdout).strip() or f"{cli} models exited {r.returncode}"
    ids = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line or line.lower().startswith("fetching"):
            continue  # agy prints a "Fetching available models..." progress line first
        ids.append(line.split("\t", 1)[0].strip())
    return ids, None


def check_model(cli, cli_path, model):
    """Whether `model` is a real id this CLI currently lists, plus the
    closest available ids when it isn't -- never fails the caller; a CLI
    with no listing command just comes back `checked: false`."""
    available, error = list_models(cli, cli_path)
    if available is None:
        return {"cli": cli, "model": model, "checked": False, "found": None,
                "closest": [], "available": [], "error": error}
    found = model in available
    closest = []
    if not found:
        # A tier default like "gemini-3.8-flash" is often a bare prefix of
        # the CLI's real, effort-suffixed ids ("gemini-3.8-flash-medium");
        # prefer that relationship over generic string-similarity matching.
        closest = [m for m in available if m.startswith(model + "-")][:3]
        if not closest:
            closest = difflib.get_close_matches(model, available, n=3, cutoff=0.4)
    return {"cli": cli, "model": model, "checked": True, "found": found,
            "closest": closest, "available": available, "error": None}


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "whoami":
        print(json.dumps(whoami(), indent=2))
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "check-model":
        args = sys.argv[2:]
        try:
            cli = args[args.index("--cli") + 1]
            model = args[args.index("--model") + 1]
        except (ValueError, IndexError):
            raise SystemExit("usage: crewbench_env.py check-model --cli <cli> --model <model>")
        cli_path = shutil.which(cli) or cli
        print(json.dumps(check_model(cli, cli_path, model), indent=2))
        return
    raise SystemExit("usage: crewbench_env.py whoami | check-model --cli <cli> --model <model>")


if __name__ == "__main__":
    main()
