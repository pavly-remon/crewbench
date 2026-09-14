#!/usr/bin/env python3
"""Run one crewbench role on a headless CLI and return a JSON result envelope.

Usage:
  python3 <root>/bin/crewbench_dispatch.py --role developer --cli agy \
      --model gemini-3.8-flash --effort medium --handoff .crewbench/runs/dev-1.md

The role brief, tool limits and result schema are added automatically; the
handoff file only needs the task itself. Child agents never run with
permission checks disabled: each CLI is started sandboxed or with a scoped
tool set, and anything the child can't do is reported under "blocked".

While the role works, a readable live log is written to <handoff>.log
(watch it with `tail -f`) and .crewbench/runs/status.json tracks every run.
When done, prints the envelope as JSON on stdout and writes it next to the
handoff file (<handoff>.result.json, raw output in <handoff>.raw.txt). The
envelope includes the child's session id and a command to reopen it. Exit
code is 0 when the role returned a valid result, 1 otherwise.
"""

import argparse
import fcntl
import json
import os
import re
import shutil
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


def build_command(args, prompt, schema_path, tmp, conversation=None):
    """Return (argv, stdin_text, codex_last_message_file). Claude and agy stream JSON events."""
    role, model, effort = args.role, args.model, args.effort
    has_effort = effort.lower() not in NO_EFFORT
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
               "--print-timeout", f"{args.timeout}s"]
        if skip:
            cmd += ["--dangerously-skip-permissions"]
        if conversation:
            cmd += ["--conversation", conversation]
        if has_effort:
            cmd += ["--effort", effort]
        return cmd + [f"-p={prompt}"], None, None
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
        return cmd + ["-p", prompt], None, None
    raise SystemExit(f"unknown cli: {args.cli}")


def git_state():
    """Snapshot HEAD, current branch and remote refs; None outside a git repo."""
    def git(*a):
        r = subprocess.run(["git", *a], capture_output=True, text=True, cwd=os.getcwd())
        return r.stdout.strip() if r.returncode == 0 else None
    head = git("rev-parse", "HEAD")
    if head is None:
        return None
    return {"head": head, "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "remotes": git("for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes")}


def git_changes(before, after):
    if not before or not after:
        return None
    changes = []
    if before["branch"] != after["branch"]:
        changes.append(f"switched branch {before['branch']} -> {after['branch']}")
    if before["head"] != after["head"]:
        changes.append(f"moved HEAD {before['head'][:8]} -> {after['head'][:8]} (commit, reset or rebase)")
    if before["remotes"] != after["remotes"]:
        changes.append("remote-tracking refs changed (push or fetch)")
    return "; ".join(changes) or None


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


def validate(result, schema):
    if not isinstance(result, dict):
        return "result is not a JSON object"
    missing = [k for k in schema["required"] if k not in result]
    if missing:
        return "result missing fields: " + ", ".join(missing)
    for key, spec in schema["properties"].items():
        if "enum" in spec and key in result and result[key] not in spec["enum"]:
            return f"{key} must be one of {spec['enum']}, got {result[key]!r}"
    return None


def update_status(runs_dir, run, fields):
    """Merge fields into .crewbench/runs/status.json under this run's name."""
    path = runs_dir / "status.json"
    with open(runs_dir / ".status.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            status = json.loads(path.read_text())
        except (OSError, ValueError):
            status = {}
        status.setdefault(run, {}).update(fields)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(status, indent=2) + "\n")
        tmp.replace(path)


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

    if shutil.which(args.cli) is None:
        envelope["error"] = f"{args.cli} is not installed or not on PATH"
        finish()

    schema_path = ROOT / "schemas" / f"{args.role}.json"
    schema = json.loads(schema_path.read_text())
    prompt = build_prompt(args.role, args.cli, handoff_path.read_text(), schema,
                          args.skip_permissions and args.role not in READ_ONLY)
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

    def run_attempt(cmd, stdin, log, stderr_path):
        with open(stderr_path, "w") as stderr_file:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE if stdin else subprocess.DEVNULL,
                                    stdout=subprocess.PIPE,
                                    # codex/copilot report progress on stderr: show it live
                                    stderr=stderr_file if args.cli in ("claude", "agy") else subprocess.STDOUT,
                                    text=True, bufsize=1, cwd=os.getcwd())
            update_status(runs_dir, run, {"state": "running", "pid": proc.pid})
            if stdin:
                proc.stdin.write(stdin)
                proc.stdin.close()

            def kill():
                timed_out.set()
                proc.kill()

            timer = threading.Timer(args.timeout + 60, kill)
            timer.start()
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
        stderr_parts.append(Path(stderr_path).read_text())
        return result_code

    with tempfile.TemporaryDirectory() as tmp, open(log_path, "w", buffering=1) as log:
        cmd, stdin, last_message = build_command(args, prompt, schema_path, tmp)
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
        for _ in range(AGY_DENIAL_RESUMES):
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
            cmd, stdin, _ = build_command(args, follow_up, schema_path, tmp, conversation=stream.session_id)
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
    git_changed = git_changes(git_before, git_state())
    problem = error or validate(result, schema)
    if git_changed:
        # Report only — the Team Lead and user decide what to keep.
        envelope["warnings"].append(f"{args.role} changed git history against its instructions: {git_changed}")
    if problem is None and code not in (0, None):
        problem = f"{args.cli} exited with code {code}"
    if problem is None and timed_out.is_set():
        problem = f"timed out after {args.timeout}s"
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
