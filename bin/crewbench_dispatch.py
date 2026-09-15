#!/usr/bin/env python3
"""Run one crewbench role on a headless CLI and return a JSON result envelope.

Usage:
  python3 <root>/bin/crewbench_dispatch.py --role developer --cli agy \
      --model gemini-3.8-flash --effort medium --handoff .crewbench/runs/dev-1.md

The role brief, tool limits and result schema are added automatically; the
handoff file only needs the task itself. By default (`permissions: safe`)
each CLI is started sandboxed or with a scoped tool set, and anything the
child can't do is reported under "blocked". Pass --skip-permissions (only
when the agreed lineup says `permissions: skip`) to run the child with
permission checks skipped instead — never enabled for the read-only
code-reviewer.

While the role works, a readable live log is written to <handoff>.log
(watch it with `tail -f`) and .crewbench/runs/status.json tracks every run.
When done, prints the envelope as JSON on stdout and writes it next to the
handoff file (<handoff>.result.json, raw output in <handoff>.raw.txt). The
envelope includes the child's session id and a command to reopen it. Exit
code is 0 when the role returned a valid result, 1 otherwise.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ROLES = {
    "developer": "developer.md",
    "tester": "tester.md",
    "code-reviewer": "code-reviewer.md",
    "ui-ux": "ui-ux-designer.md",
}

GIT_RULE = "Never commit, push or otherwise change git history or branches — leave changes uncommitted; the Team Lead commits after the user confirms."

LIMITS = {
    "developer": "You may read and edit files in the project and run shell commands. " + GIT_RULE,
    "tester": "You may read files, add or edit test files, and run shell commands. Do not change non-test source code. " + GIT_RULE,
    "code-reviewer": "You are read-only: do not edit files or run commands that change anything.",
    "ui-ux": "You may read files and write design documents. Do not run shell commands or write implementation code.",
}

CLAUDE_TOOLS = {
    "developer": "Read,Write,Edit,Bash,Grep,Glob",
    "tester": "Read,Write,Edit,Bash,Grep,Glob",
    "code-reviewer": "Read,Grep,Glob",
    "ui-ux": "Read,Write,Edit,Grep,Glob",
}

READ_ONLY = {"code-reviewer"}
AGY_DENIAL_RESUMES = 2
NO_EFFORT = {"", "none", "n/a"}
MAX_ARGV_BYTES = 100_000  # guard well under Linux's 128 KiB MAX_ARG_STRLEN per argv element
GRACEFUL_KILL_TIMEOUT = 10  # seconds between SIGTERM and SIGKILL for a run's process group

# Heuristic for "this looks like a test file", used to flag a tester role editing
# non-test source. Kept as a module constant so Phase 6's project profile can extend it.
TEST_PATH_PATTERNS = re.compile(
    r"(^|[\\/])(tests?|__tests__|spec|e2e)([\\/]|$)|\.(test|spec)\.[^./\\]+$", re.I)


def is_test_path(path, extra_pattern=None):
    if TEST_PATH_PATTERNS.search(path):
        return True
    return bool(extra_pattern and extra_pattern.search(path))


def resolve_cli_path(cli):
    """The executable to run for `cli`: CREWBENCH_CLI_OVERRIDE_<CLI> if set
    (for tests — inject a fake CLI script without touching the production
    path), otherwise whatever's on PATH."""
    override = os.environ.get(f"CREWBENCH_CLI_OVERRIDE_{cli.upper()}")
    return override or shutil.which(cli)


def strip_frontmatter(text):
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def agy_command_rules():
    """Return (usable, broken) command rules from the user's agy allow list.

    agy matches command(...) targets as literal word-by-word prefixes; `*` only
    works alone (command(*)), so a rule like command(ls*) never matches `ls`.
    """
    settings = Path.home() / ".gemini" / "antigravity-cli" / "settings.json"
    try:
        rules = json.loads(settings.read_text()).get("permissions", {}).get("allow", [])
    except (OSError, ValueError):
        return [], []
    usable, broken = [], []
    for rule in rules:
        if not (isinstance(rule, str) and rule.startswith("command(") and rule.endswith(")")):
            continue
        target = rule[len("command("):-1]
        if target != "*" and "*" in target and not target.startswith("regex:"):
            broken.append(rule)
        else:
            usable.append(target)
    return usable, broken


AGY_FILE_TOOLS = (
    "Use your built-in file tools — view_file, list_dir, find_by_name, grep_search, "
    "replace_file_content, write_to_file — to read, search and edit. Never use shell "
    "commands such as ls, cat, head, tail, find, grep or sed for that."
)


def limits_for(role, cli, skip=False):
    text = LIMITS[role]
    if cli == "agy":
        text += "\n\n" + AGY_FILE_TOOLS
        if role not in READ_ONLY and role != "ui-ux" and not skip:
            usable, _ = agy_command_rules()
            if "*" in usable:
                allowed = "any command"
            elif usable:
                allowed = ", ".join(
                    f"`{t[len('regex:'):]}` (regex)" if t.startswith("regex:") else f"`{t}` (and `{t} ...`)"
                    for t in usable)
            else:
                allowed = "none"
            text += (
                "\n\nShell commands are restricted in this run. Only these commands are "
                "allowed: " + allowed + ". Any other command is denied. Don't run it or a "
                "variant of it — if you truly need it (e.g. to run tests), list it under "
                "\"blocked\" and carry on.")
    if cli == "copilot" and role in ("developer", "tester") and not skip:
        text += "\n\nShell commands are not available in this run; list any you needed under \"blocked\"."
    return text


def build_prompt(role, cli, handoff, schema, skip=False):
    brief = strip_frontmatter((ROOT / "agents" / ROLES[role]).read_text())
    return "\n\n".join([
        brief.strip(),
        "## Limits\n\n" + limits_for(role, cli, skip),
        "## Hand-off from the Team Lead\n\n" + handoff.strip(),
        "## How to report\n\n"
        "You are running non-interactively as part of a crewbench team. Don't ask "
        "questions; put ambiguities in your result. If an action you need is denied "
        "or blocked by the sandbox, don't try to work around it — list it under "
        "\"blocked\" and continue with what you can do.\n\n"
        "Your final answer must be a single JSON object matching this JSON Schema, "
        "with no text before or after it:\n\n" + json.dumps(schema, indent=2),
    ])


def _prompt_pointer(prompt_file):
    """Short text for CLIs whose -p/--prompt takes the prompt as an argv value
    (no documented stdin mode: agy and Copilot, per `--help` as of writing —
    VERIFY if a future version adds one) instead of the full prompt, to avoid
    E2BIG on large hand-offs (see MAX_ARGV_BYTES below)."""
    return (
        "Your complete instructions for this task are in the file at this exact "
        f"absolute path: {prompt_file}\n\nRead the whole file and follow it exactly "
        "— it contains your role brief, your limits for this run, the Team Lead's "
        "hand-off, and how to report your final answer. Treat it as if it were "
        "written here directly; this message is only a pointer to it.")


def build_command(args, prompt, prompt_file, schema_path, tmp, conversation=None, timeout_s=None):
    """Return (argv, stdin_text, codex_last_message_file). Claude and agy stream JSON events.

    `prompt` is the full assembled prompt; `prompt_file` is where it (or, for a
    resume follow-up, the follow-up text) was written to disk. Claude and Codex
    read the full prompt from stdin (no argv size limit there); agy and Copilot
    get a short pointer to `prompt_file` instead.
    """
    role, model, effort = args.role, args.model, args.effort
    has_effort = effort.lower() not in NO_EFFORT
    timeout_s = args.timeout if timeout_s is None else timeout_s
    # --skip-permissions never applies to the read-only reviewer.
    skip = args.skip_permissions and role not in READ_ONLY
    if args.cli == "claude":
        # plan keeps the reviewer read-only; auto has a classifier review each
        # action; bypassPermissions (opt-in) skips permission checks.
        mode = "plan" if role in READ_ONLY else ("bypassPermissions" if skip else "auto")
        cmd = ["claude", "-p", "--model", model, "--output-format", "stream-json", "--verbose",
               "--json-schema", schema_path.read_text(),
               "--tools", CLAUDE_TOOLS[role], "--strict-mcp-config",
               "--permission-mode", mode]
        if has_effort:
            cmd += ["--effort", effort]
        return cmd, prompt, None
    if args.cli == "agy":
        # --add-dir makes the project agy's workspace, so reads and edits there
        # don't need a prompt; shell commands still follow the user's allowlist.
        cmd = ["agy", "--model", model, "--sandbox", "--add-dir", os.getcwd(),
               "--mode", "plan" if role in READ_ONLY else "accept-edits",
               "--output-format", "stream-json", "--json-schema", str(schema_path),
               "--print-timeout", f"{max(1, int(timeout_s))}s"]
        if skip:
            cmd += ["--dangerously-skip-permissions"]
        if conversation:
            cmd += ["--conversation", conversation]
        if has_effort:
            cmd += ["--effort", effort]
        return cmd + [f"-p={_prompt_pointer(prompt_file)}"], None, None
    if args.cli == "codex":
        last = Path(tmp) / "last-message.txt"
        cmd = ["codex", "exec", "-m", model,
               "-s", "read-only" if role in READ_ONLY else ("danger-full-access" if skip else "workspace-write"),
               "--output-schema", str(schema_path), "-o", str(last)]
        if has_effort:
            cmd += ["-c", f"model_reasoning_effort={effort}"]
        return cmd + ["-"], prompt, last
    if args.cli == "copilot":
        cmd = ["copilot", "-s", "--no-ask-user", "--model", model]
        if skip:
            cmd += ["--allow-all-tools"]
        else:
            # Copilot has no per-run sandbox flag, so shell stays denied.
            cmd += ["--deny-tool=shell", "--deny-tool=url"]
            if role not in READ_ONLY:
                cmd += ["--allow-tool=write"]
        if has_effort:
            cmd += ["--effort", effort]
        return cmd + ["-p", _prompt_pointer(prompt_file)], None, None
    raise SystemExit(f"unknown cli: {args.cli}")


def check_argv_size(cmd):
    """Fail fast with a clear error instead of letting exec() fail with E2BIG."""
    for element in cmd:
        size = len(element.encode("utf-8", "surrogateescape"))
        if size > MAX_ARGV_BYTES:
            raise ValueError(
                f"a single command-line argument is {size} bytes, over the "
                f"{MAX_ARGV_BYTES}-byte guard (real OS limits are ~128 KiB and "
                "vary by platform) — this would likely fail with E2BIG; the "
                f"offending value starts with: {element[:200]!r}")


def _git(*args, cwd):
    r = subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd)
    return r.stdout.strip() if r.returncode == 0 else None


def _hash_file(cwd, path):
    try:
        with open(os.path.join(cwd, path), "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None  # deleted, a symlink to nowhere, or unreadable


def _dirty_snapshot(cwd):
    """Map path -> content hash (None if deleted) for every modified/added/
    untracked-but-not-ignored path, from `git status --porcelain=v1 -z`."""
    r = subprocess.run(["git", "status", "--porcelain=v1", "-z"],
                        capture_output=True, cwd=cwd)
    if r.returncode != 0:
        return {}
    fields = r.stdout.decode("utf-8", "replace").split("\0")
    dirty = {}
    i = 0
    while i < len(fields):
        entry = fields[i]
        i += 1
        if not entry:
            continue
        code, path = entry[:2], entry[3:]
        if "R" in code or "C" in code:
            i += 1  # rename/copy entries carry an extra "original path" field
        dirty[path] = None if "D" in code else _hash_file(cwd, path)
    return dirty


def git_state(cwd=None):
    """Snapshot HEAD, branch, remote refs, stash and working-tree dirt.

    Returns None outside a git repo. Used both to report roles that change git
    history and, via `dirty`, to catch a role silently reverting or discarding
    its own (or an earlier round's) uncommitted work.
    """
    cwd = cwd or os.getcwd()
    head = _git("rev-parse", "HEAD", cwd=cwd)
    if head is None:
        return None
    upstream = _git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", cwd=cwd)
    return {
        "head": head,
        "branch": _git("rev-parse", "--abbrev-ref", "HEAD", cwd=cwd),
        "remotes": _git("for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", cwd=cwd),
        "stash": _git("stash", "list", "--format=%H", cwd=cwd) or "",
        "upstream": upstream,
        "upstream_commit": _git("rev-parse", "@{u}", cwd=cwd) if upstream else None,
        "dirty": _dirty_snapshot(cwd),
    }


def git_changes(role, before, after, extra_test_pattern=None):
    """Return (warnings, notes) describing what changed in the working tree
    and git state between two git_state() snapshots. Report-only: never undoes
    anything. `role` tailors a couple of checks (read-only reviewer, tester)."""
    if not before or not after:
        return [], []
    warnings, notes = [], []
    if before["branch"] != after["branch"]:
        warnings.append(f"{role} switched branch {before['branch']} -> {after['branch']}")
    if before["head"] != after["head"]:
        warnings.append(f"{role} moved HEAD {before['head'][:8]} -> {after['head'][:8]} (commit, reset or rebase)")
    if before["stash"] != after["stash"]:
        warnings.append(f"{role} changed the stash list (git stash)")

    before_dirty, after_dirty = before.get("dirty", {}), after.get("dirty", {})
    # A path is "reverted or deleted" if it was dirty before and is either gone
    # from the dirty set now (matches HEAD again) or now shows as deleted.
    reverted = sorted(
        path for path in before_dirty
        if path not in after_dirty or after_dirty[path] is None
    )
    if reverted:
        warnings.append(f"{role} reverted or deleted uncommitted changes in: {', '.join(reverted)}")

    if role == "code-reviewer" and before_dirty != after_dirty:
        warnings.append(f"{role} is read-only but the working tree changed")

    if role == "tester":
        touched = {p for p in after_dirty if after_dirty.get(p) != before_dirty.get(p)}
        non_test = sorted(p for p in touched if not is_test_path(p, extra_test_pattern))
        if non_test:
            warnings.append(f"tester changed non-test files: {', '.join(non_test)}")

    if before["remotes"] != after["remotes"]:
        history_moved = before["head"] != after["head"]
        pushed = (
            before.get("upstream_commit") and after.get("upstream_commit")
            and before["upstream_commit"] != after["upstream_commit"]
            and after["upstream_commit"] == after["head"]
        )
        if pushed:
            warnings.append(f"{role} pushed to {after.get('upstream')}")
        elif not history_moved:
            notes.append("remote-tracking refs updated (likely git fetch)")
        else:
            notes.append("remote-tracking refs changed alongside local history — not necessarily a push")
    return warnings, notes


def resume_command(cli, session_id):
    if not session_id:
        return {"copilot": "copilot --continue"}.get(cli)
    return {
        "claude": f"claude --resume {session_id}",
        "agy": f"agy --conversation {session_id}",
        "codex": f"codex resume {session_id}",
        "copilot": f"copilot --resume={session_id}",
    }[cli]


def extract_json(text):
    """Find the last top-level JSON object in free text."""
    if not text:
        return None
    text = text.strip()
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except ValueError:
        pass
    for block in reversed(re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)):
        try:
            return json.loads(block)
        except ValueError:
            continue
    decoder = json.JSONDecoder()
    found = None
    for i, ch in enumerate(text):
        if ch == "{":
            try:
                value, _ = decoder.raw_decode(text[i:])
            except ValueError:
                continue
            if isinstance(value, dict):
                found = value
    return found


def short(value, limit=160):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


class Stream:
    """Turns a CLI's output lines into live log lines and remembers what matters."""

    def __init__(self, cli):
        self.cli = cli
        self.session_id = None
        self.final = None  # claude/agy final result event
        self.denied_commands = []  # agy commands refused by its permission check

    def feed(self, line):
        """Return readable log lines for one output line."""
        if self.cli == "claude":
            return self._claude(line)
        if self.cli == "agy":
            return self._agy(line)
        if self.session_id is None:
            match = re.search(r"session id:\s*([0-9a-fA-F-]{8,})", line)
            if match:
                self.session_id = match.group(1)
        return [line.rstrip("\n")] if line.strip() else []

    def _event(self, line):
        try:
            event = json.loads(line)
            return event if isinstance(event, dict) else None
        except ValueError:
            return None

    def _claude(self, line):
        event = self._event(line)
        if event is None:
            return [line.rstrip("\n")] if line.strip() else []
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            self.session_id = event.get("session_id")
            return [f"session started ({event.get('model', '')}) id={self.session_id}"]
        if kind == "result":
            self.final = event
            return [f"finished: {event.get('subtype', '')}"]
        out = []
        for block in (event.get("message") or {}).get("content") or []:
            if not isinstance(block, dict):
                continue
            if kind == "assistant" and block.get("type") == "text" and block.get("text", "").strip():
                out.append("says: " + short(block["text"]))
            elif kind == "assistant" and block.get("type") == "tool_use":
                out.append(f"tool: {block.get('name')} {short(block.get('input', {}))}")
            elif kind == "user" and block.get("type") == "tool_result" and block.get("is_error"):
                out.append("  error: " + short(block.get("content", "")))
        return out

    def _agy(self, line):
        event = self._event(line)
        if event is None:
            return [line.rstrip("\n")] if line.strip() else []
        kind = event.get("event")
        if kind == "init":
            self.session_id = event.get("conversation_id")
            return [f"session started ({(event.get('init') or {}).get('model', '')}) id={self.session_id}"]
        if kind == "result":
            self.final = event.get("result") or {}
            return [f"finished: {self.final.get('status', '')}"]
        step = event.get("step_update") or {}
        if step.get("step_type") != "tool" or step.get("state") == "ACTIVE":
            return []
        info = step.get("tool_info") or {}
        text = f"tool: {step.get('tool_name')} {short(info.get('parameters', {}))}"
        if step.get("state") == "ERROR":
            message = (info.get("error") or {}).get("message", "error")
            text += "  -> " + short(message)
            command = (info.get("parameters") or {}).get("CommandLine")
            if command and "permission check failed" in message:
                self.denied_commands.append(command)
        return [text]


def parse_output(cli, stream, stdout, last_message_file):
    """Return (result, permission_denials, error)."""
    if cli in ("claude", "agy"):
        final = stream.final
        if final is None:
            return None, [], "no result event in output"
        denials = final.get("permission_denials") or final.get("denied_actions") or []
        if isinstance(final.get("structured_output"), dict):
            return final["structured_output"], denials, None
        if final.get("is_error") or final.get("status") not in (None, "SUCCESS"):
            return None, denials, str(final.get("result") or final.get("error") or final.get("status"))
        text = final.get("result") or final.get("response") or ""
        return extract_json(text), denials, None
    if cli == "codex" and last_message_file and last_message_file.exists():
        return extract_json(last_message_file.read_text()), [], None
    return extract_json(stdout), [], None


_JSON_TYPES = {
    "string": str, "boolean": bool, "array": list, "object": dict, "null": type(None),
}


def _type_ok(value, type_name):
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    expected = _JSON_TYPES.get(type_name)
    return expected is not None and isinstance(value, expected)


def validate_schema(value, schema, path=""):
    """Recursively validate `value` against a JSON Schema subset: type
    (including type lists), enum, required, properties, additionalProperties:
    false, items. Returns None or a precise "<path> <problem>" error string."""
    label = path or "result"
    schema_type = schema.get("type")
    if schema_type is not None:
        types = schema_type if isinstance(schema_type, list) else [schema_type]
        if not any(_type_ok(value, t) for t in types):
            return f"{label} must be of type {schema_type}, got {type(value).__name__}"
    if "enum" in schema and value not in schema["enum"]:
        return f"{label} must be one of {schema['enum']}, got {value!r}"
    if isinstance(value, dict) and "properties" in schema:
        missing = [k for k in schema.get("required", []) if k not in value]
        if missing:
            return f"{label} missing required fields: {', '.join(missing)}"
        props = schema["properties"]
        if schema.get("additionalProperties") is False:
            extra = [k for k in value if k not in props]
            if extra:
                return f"{label} has unexpected fields: {', '.join(extra)}"
        for key, subschema in props.items():
            if key in value:
                child = f"{path}.{key}" if path else key
                err = validate_schema(value[key], subschema, child)
                if err:
                    return err
    if isinstance(value, list) and "items" in schema:
        items_schema = schema["items"]
        for i, item in enumerate(value):
            err = validate_schema(item, items_schema, f"{path}[{i}]" if path else f"[{i}]")
            if err:
                return err
    return None


def validate(result, schema):
    if not isinstance(result, dict):
        return "result is not a JSON object"
    return validate_schema(result, schema, "")


def _lock_file(handle):
    """Take an exclusive lock on an open file handle. POSIX uses fcntl, Windows msvcrt.

    Imported lazily so the module loads on platforms missing the other's lock module.
    """
    if os.name == "nt":
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
    else:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_EX)


def _unlock_file(handle):
    if os.name == "nt":
        import msvcrt
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    # POSIX: fcntl locks release automatically when the file descriptor closes.


def update_status(runs_dir, run, fields):
    """Merge fields into .crewbench/runs/status.json under this run's name."""
    path = runs_dir / "status.json"
    with open(runs_dir / ".status.lock", "w") as lock:
        _lock_file(lock)
        try:
            try:
                status = json.loads(path.read_text())
            except (OSError, ValueError):
                status = {}
            status.setdefault(run, {}).update(fields)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(status, indent=2) + "\n")
            tmp.replace(path)
        finally:
            _unlock_file(lock)


def now():
    return time.strftime("%H:%M:%S")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--role", required=True, choices=ROLES)
    p.add_argument("--cli", required=True, choices=["claude", "agy", "codex", "copilot"])
    p.add_argument("--model", required=True)
    p.add_argument("--effort", default="medium", help='low|medium|high|xhigh|max, or "none" to omit')
    p.add_argument("--handoff", required=True, help="file with the task hand-off")
    p.add_argument("--timeout", type=int, default=1800, help="seconds (default 1800)")
    p.add_argument("--skip-permissions", action="store_true",
                   help="run the child with permission checks skipped (ignored for code-reviewer)")
    args = p.parse_args()

    handoff_path = Path(args.handoff)
    runs_dir = handoff_path.resolve().parent
    run = handoff_path.stem
    out_path = handoff_path.with_suffix(".result.json")
    raw_path = handoff_path.with_suffix(".raw.txt")
    log_path = handoff_path.with_suffix(".log")
    envelope = {"role": args.role, "cli": args.cli, "model": args.model, "effort": args.effort,
                "skip_permissions": args.skip_permissions and args.role not in READ_ONLY,
                "ok": False, "exit_code": None, "duration_s": None, "result": None,
                "permission_denials": [], "error": None, "session_id": None, "resume_command": None,
                "result_file": str(out_path), "log_file": str(log_path), "raw_output_file": str(raw_path)}

    def finish():
        out_path.write_text(json.dumps(envelope, indent=2) + "\n")
        update_status(runs_dir, run, {"state": "done" if envelope["ok"] else "failed",
                                      "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                      "session_id": envelope["session_id"],
                                      "resume_command": envelope["resume_command"],
                                      "error": envelope["error"]})
        print(json.dumps(envelope, indent=2))
        sys.exit(0 if envelope["ok"] else 1)

    cli_path = resolve_cli_path(args.cli)
    if cli_path is None:
        envelope["error"] = f"{args.cli} is not installed or not on PATH"
        finish()

    schema_path = ROOT / "schemas" / f"{args.role}.json"
    schema = json.loads(schema_path.read_text())
    prompt = build_prompt(args.role, args.cli, handoff_path.read_text(), schema,
                          args.skip_permissions and args.role not in READ_ONLY)
    prompt_path = handoff_path.with_suffix(".prompt.md")
    prompt_path.write_text(prompt)
    stream = Stream(args.cli)
    stdout_lines, stderr_parts = [], []
    warnings = []
    if args.cli == "agy" and not envelope["skip_permissions"]:
        _, broken = agy_command_rules()
        if broken:
            warnings.append(
                "agy never matches these allow rules, because agy uses word-by-word prefixes and "
                "only a bare * wildcard: " + ", ".join(broken) + ". Write them without the * "
                "(e.g. command(ls) allows `ls` and `ls -la`).")
    envelope["warnings"] = warnings
    timed_out = threading.Event()
    code = None
    # One deadline for the whole run, including agy denial-resumes: each attempt
    # only gets what's left, so retries can't stack into ~N x --timeout.
    deadline = time.time() + args.timeout

    def spawn(cmd, stdin):
        popen_kwargs = {}
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["start_new_session"] = True  # own process group, for group-kill on timeout
        return subprocess.Popen(cmd, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL,
                                stdout=subprocess.PIPE,
                                # codex/copilot report progress on stderr: show it live
                                stderr=subprocess.PIPE if args.cli in ("claude", "agy") else subprocess.STDOUT,
                                text=True, bufsize=1, cwd=os.getcwd(), **popen_kwargs)

    def kill_process_tree(proc):
        """Kill the whole process group/tree, not just the direct child (the
        CLIs spawn node/helper processes that would otherwise survive)."""
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        try:
            pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            return
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            return

        def hard_kill():
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass

        hard_timer = threading.Timer(GRACEFUL_KILL_TIMEOUT, hard_kill)
        hard_timer.start()
        try:
            proc.wait(timeout=GRACEFUL_KILL_TIMEOUT)
        except subprocess.TimeoutExpired:
            pass
        finally:
            hard_timer.cancel()

    def run_attempt(cmd, stdin, log, stderr_path):
        remaining = deadline - time.time()
        if remaining <= 1:
            timed_out.set()
            return None
        proc = spawn(cmd, stdin)
        update_status(runs_dir, run, {"state": "running", "pid": proc.pid})
        if stdin:
            proc.stdin.write(stdin)
            proc.stdin.close()

        def kill():
            timed_out.set()
            kill_process_tree(proc)

        timer = threading.Timer(remaining, kill)
        timer.start()
        stderr_thread = None
        if proc.stderr is not None:
            def drain_stderr():
                with open(stderr_path, "a") as f:
                    for line in proc.stderr:
                        f.write(line)
            stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
            stderr_thread.start()
        recorded_session = stream.session_id
        for line in proc.stdout:
            stdout_lines.append(line)
            for entry in stream.feed(line):
                log.write(f"[{now()}] {entry}\n")
            if stream.session_id and stream.session_id != recorded_session:
                recorded_session = stream.session_id
                update_status(runs_dir, run, {"session_id": recorded_session})
        result_code = proc.wait()
        timer.cancel()
        if stderr_thread:
            stderr_thread.join(timeout=5)
        stderr_parts.append(Path(stderr_path).read_text() if Path(stderr_path).exists() else "")
        return result_code

    with tempfile.TemporaryDirectory() as tmp, open(log_path, "w", buffering=1) as log:
        cmd, stdin, last_message = build_command(args, prompt, prompt_path, schema_path, tmp,
                                                 timeout_s=deadline - time.time())
        cmd[0] = cli_path
        try:
            check_argv_size(cmd)
        except ValueError as exc:
            envelope["error"] = str(exc)
            finish()
        stderr_path = Path(tmp) / "stderr.txt"
        log.write(f"[{now()}] {args.role} on {args.cli} ({args.model}, effort {args.effort})\n")
        for warning in warnings:
            log.write(f"[{now()}] warning: {warning}\n")
        update_status(runs_dir, run, {"role": args.role, "cli": args.cli, "model": args.model,
                                      "effort": args.effort, "state": "running",
                                      "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                      "log_file": str(log_path), "session_id": None})
        print(f"crewbench: {run} running on {args.cli} — live log: tail -f {log_path}",
              file=sys.stderr, flush=True)
        start = time.time()
        git_before = git_state()
        code = run_attempt(cmd, stdin, log, stderr_path)

        # Headless agy ends the whole run when a command is denied. Resume the same
        # conversation, tell it the command stays denied, and let it carry on.
        denied_seen = []
        for resume_n in range(AGY_DENIAL_RESUMES):
            final = stream.final or {}
            new_denied = [c for c in stream.denied_commands if c not in denied_seen]
            if (args.cli != "agy" or timed_out.is_set() or not stream.session_id or not new_denied
                    or isinstance(final.get("structured_output"), dict)):
                break
            denied_seen += new_denied
            log.write(f"[{now()}] resuming after denied command(s): {', '.join(denied_seen)}\n")
            stream.final = None
            follow_up = (
                "These shell commands were denied by the permission check and will be denied "
                "again: " + ", ".join(f"`{c}`" for c in denied_seen) + ". Do not run them or "
                "variants of them. " + AGY_FILE_TOOLS + " If a command is truly required, list "
                "it under \"blocked\". Continue the task from where you stopped, then give your "
                "final answer as the JSON object described earlier.")
            resume_prompt_path = handoff_path.with_suffix(f".resume{resume_n + 1}.prompt.md")
            resume_prompt_path.write_text(follow_up)
            cmd, stdin, _ = build_command(args, follow_up, resume_prompt_path, schema_path, tmp,
                                          conversation=stream.session_id,
                                          timeout_s=deadline - time.time())
            cmd[0] = cli_path
            try:
                check_argv_size(cmd)
            except ValueError as exc:
                envelope["error"] = str(exc)
                finish()
            code = run_attempt(cmd, stdin, log, stderr_path)

        stderr = "\n".join(stderr_parts)
        stdout = "".join(stdout_lines)
        if timed_out.is_set():
            code, stderr = None, stderr + f"\ntimed out after {args.timeout}s"
        envelope["duration_s"] = round(time.time() - start, 1)
        envelope["exit_code"] = code
        envelope["session_id"] = stream.session_id
        envelope["resume_command"] = resume_command(args.cli, stream.session_id)
        raw_path.write_text(f"$ {cmd[0]} ...\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n")
        result, denials, error = parse_output(args.cli, stream, stdout, last_message)
        if stream.denied_commands:
            denials = [{"action": "command", "command": c} for c in dict.fromkeys(stream.denied_commands)]
        log.write(f"[{now()}] exit {code} after {envelope['duration_s']}s\n")

    envelope["permission_denials"] = denials
    envelope["result"] = result
    git_warnings, git_notes = git_changes(args.role, git_before, git_state())
    problem = error or validate(result, schema)
    # Report only — the Team Lead and user decide what to keep; never undo anything here.
    envelope["warnings"].extend(git_warnings)
    envelope["notes"] = git_notes
    if problem is None and code not in (0, None):
        problem = f"{args.cli} exited with code {code}"
    if timed_out.is_set():
        # Take priority over a generic "no result event" from parse_output —
        # a timeout is always the more useful explanation for that.
        timeout_msg = f"timed out after {args.timeout}s"
        problem = timeout_msg if problem is None else f"{timeout_msg} ({problem})"
    if problem and args.cli == "agy" and denials:
        targets = [d.get("command") or d.get("action", "?") for d in denials if isinstance(d, dict)]
        problem += (" | headless agy denied: " + ", ".join(targets) + ". agy only runs commands "
                    "matching permissions.allow in ~/.gemini/antigravity-cli/settings.json, e.g. "
                    "command(npm test)")
    if problem:
        tail = (stderr or stdout or "").strip().splitlines()[-5:]
        problem += "" if not tail else " | " + " / ".join(short(t, 300) for t in tail)
    envelope["error"] = problem
    envelope["ok"] = problem is None
    finish()


if __name__ == "__main__":
    main()
