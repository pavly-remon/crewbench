#!/usr/bin/env python3
"""Run one crewbench role on a headless CLI and return a JSON result envelope.

Usage:
  python3 <root>/bin/crewbench_dispatch.py --role developer --cli agy \
      --model gemini-3.8-flash --effort medium --round 1 \
      --task-dir .crewbench/tasks/<task-id> --handoff <path-to-hand-off.md>

With --task-dir, run artifacts (log, prompt, result, raw output) are named
<task-dir>/runs/<role>-r<round>.*, so the round is always in the filename.
Without it (pre-Phase-4 callers), they're named after --handoff itself,
e.g. --handoff foo/dev-1.md writes foo/dev-1.result.json etc.

The role brief, tool limits and result schema are added automatically; the
handoff file only needs the task itself. By default (`permissions: safe`)
each CLI is started sandboxed or with a scoped tool set, and anything the
child can't do is reported under "blocked". Pass --skip-permissions (only
when the agreed lineup says `permissions: skip`) to run the child with
permission checks skipped instead — never enabled for the read-only
code-reviewer.

While the role works, a readable live log is written to <run>.log (watch it
with `tail -f`) and <task-dir>/runs/status.json (or the handoff's directory,
pre-Phase-4) tracks every run. When done, prints the envelope as JSON on
stdout and writes it to <run>.result.json (raw output in <run>.raw.txt). The
envelope includes the child's session id, a command to reopen it, and a
`usage` field with whatever timing/token/cost data that CLI actually
exposed (fields are null where the CLI doesn't report them; missing usage
never fails a run). Exit code is 0 when the role returned a valid result,
1 otherwise.
"""

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crewbench_env import CONFIG_DIRS, cli_argv_prefix  # noqa: E402
from crewbench_fs import SCHEMA_VERSION, _lock_file, _unlock_file, now_iso  # noqa: E402

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

# Env var name prefixes each host CLI is confirmed (claude) or believed
# (codex/agy/copilot -- VERIFY, inferred from their own env-var prefixes
# documented in --help / `copilot help environment`, not from a live nested
# session) to set, so a child launched on a *different* CLI doesn't inherit
# host-identity markers that could change its behavior (e.g. a nested claude
# thinking it's still the outer Claude Code session). Confirmed: CLAUDECODE=1
# and CLAUDE_CODE_* are present in this script's own environment when it runs
# under Claude Code. Never touches CREWBENCH_* -- those are what this script
# itself sets for the child below.
HOST_ENV_PREFIXES = {
    "claude": ("CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_PLUGIN_ROOT", "CLAUDE_EFFORT", "AI_AGENT"),
    "codex": ("CODEX_",),
    "agy": ("ANTIGRAVITY_", "GEMINI_CLI"),
    "copilot": ("COPILOT_",),
}


def child_env(cli, role, task_id):
    """Environment for the launched child CLI process: strips other hosts'
    identity markers and sets the recursion guard the child's own
    crewbench_dispatch.py (if it has crewbench installed too) checks below."""
    env = dict(os.environ)
    for host, prefixes in HOST_ENV_PREFIXES.items():
        if host == cli:
            continue
        for key in list(env):
            if key.startswith(prefixes):
                del env[key]
    env["CREWBENCH_ROLE"] = role
    env["CREWBENCH_TASK"] = task_id or ""
    return env

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
        rules = json.loads(settings.read_text(encoding="utf-8")).get("permissions", {}).get("allow", [])
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
    brief = strip_frontmatter((ROOT / "agents" / ROLES[role]).read_text(encoding="utf-8"))
    return "\n\n".join([
        brief.strip(),
        "## Limits\n\n" + limits_for(role, cli, skip),
        "## Hand-off from the Team Lead\n\n" + handoff.strip(),
        "## Running non-interactively\n\n"
        "You are running non-interactively as part of a crewbench team. Don't ask "
        "questions; put ambiguities in your result. If an action you need is denied "
        "or blocked by the sandbox, don't try to work around it — list it under "
        "\"blocked\" and continue with what you can do. Your brief's \"Report format\" "
        "section above already told you to end with a single JSON object and nothing "
        "else — here is the exact JSON Schema it must match:\n\n" + json.dumps(schema, indent=2),
    ])


def codex_strict_schema(schema):
    """Codex's `--output-schema` is passed straight through to OpenAI's
    structured-outputs "strict" mode, which requires every key in an
    object's `properties` to also appear in that object's `required`
    (confirmed live: a schema with an optional top-level property, e.g.
    code-reviewer's `previous_issues`, gets rejected with a 400
    "'required' ... including every key in properties" error before the
    model even runs). Our own schemas/*.json intentionally leave some
    properties out of `required` (they're genuinely optional — omitted or
    empty when not applicable — and `validate()`/every other CLI treats
    them that way), so this returns a *separate*, codex-only transformed
    copy rather than editing the canonical schema: every property is
    added to `required`, and any property that wasn't already required
    gets `null` unioned into its `type` so the model can still supply
    nothing for it in effect (the existing `line: ["integer", "null"]`
    style elsewhere in these schemas is the same pattern, just applied
    here to every optional key instead of by hand)."""
    schema = copy.deepcopy(schema)

    def walk(node):
        if not isinstance(node, dict):
            return
        if node.get("type") == "object" and isinstance(node.get("properties"), dict):
            props = node["properties"]
            already_required = set(node.get("required") or [])
            for key, subschema in props.items():
                if key not in already_required and isinstance(subschema, dict):
                    t = subschema.get("type")
                    if isinstance(t, list) and "null" not in t:
                        subschema["type"] = t + ["null"]
                    elif isinstance(t, str) and t != "null":
                        subschema["type"] = [t, "null"]
                walk(subschema)
            node["required"] = list(props.keys())
        elif node.get("type") == "array" and isinstance(node.get("items"), dict):
            walk(node["items"])

    walk(schema)
    return schema


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
               "--json-schema", schema_path.read_text(encoding="utf-8"),
               "--tools", CLAUDE_TOOLS[role], "--strict-mcp-config",
               "--permission-mode", mode]
        if has_effort:
            cmd += ["--effort", effort]
        return cmd, prompt, None
    if args.cli == "agy":
        # --add-dir makes the project agy's workspace, so reads and edits there
        # don't need a prompt; shell commands still follow the user's allowlist.
        cmd = ["agy", "--model", model, "--sandbox", "--add-dir", args.cwd,
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
        # OpenAI structured-outputs strict mode (confirmed live) rejects our
        # canonical schema files as-is whenever they have an optional
        # top-level property (e.g. code-reviewer's previous_issues, tester's
        # screenshots) -- codex gets its own transformed copy instead of the
        # canonical file. See codex_strict_schema()'s docstring.
        strict_schema_path = Path(tmp) / "output-schema.json"
        strict_schema_path.write_text(
            json.dumps(codex_strict_schema(json.loads(schema_path.read_text(encoding="utf-8")))),
            encoding="utf-8")
        cmd = ["codex", "exec", "-m", model,
               "-s", "read-only" if role in READ_ONLY else ("danger-full-access" if skip else "workspace-write"),
               "--output-schema", str(strict_schema_path), "-o", str(last)]
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
        return extract_json(last_message_file.read_text(encoding="utf-8")), [], None
    return extract_json(stdout), [], None


# Best-effort token-count scan of plain-text CLI output, for CLIs (codex,
# copilot) that don't expose usage through a structured event today. VERIFY:
# no confirmed "tokens used" footer was found in `codex exec --help` or
# `copilot --help` as of writing; this stays null rather than guessing when
# nothing matches.
USAGE_TEXT_PATTERNS = [
    re.compile(r"tokens?\s*used[:\s]+([\d,]+)", re.I),
    re.compile(r"total\s*tokens[:\s]+([\d,]+)", re.I),
]


def _usage_from_text(text):
    for pattern in USAGE_TEXT_PATTERNS:
        match = pattern.search(text or "")
        if match:
            try:
                return int(match.group(1).replace(",", ""))
            except ValueError:
                continue
    return None


def extract_usage(cli, stream, stdout, duration_s):
    """Whatever usage/cost data this run's CLI actually exposed — every
    field but `duration_s` may be null; a run's ok/error never depends on
    this being complete (never fails a run over missing usage)."""
    usage = {"duration_s": duration_s, "input_tokens": None, "output_tokens": None,
             "total_tokens": None, "cost_usd": None, "num_turns": None}
    final = stream.final if isinstance(stream.final, dict) else {}
    if cli == "claude":
        # Confirmed shape: Claude Code's documented stream-json terminal
        # `result` event (`usage`, `total_cost_usd`, `num_turns`).
        raw = final.get("usage") if isinstance(final.get("usage"), dict) else {}
        usage["input_tokens"] = raw.get("input_tokens")
        usage["output_tokens"] = raw.get("output_tokens")
        if isinstance(usage["input_tokens"], int) and isinstance(usage["output_tokens"], int):
            usage["total_tokens"] = usage["input_tokens"] + usage["output_tokens"]
        usage["cost_usd"] = final.get("total_cost_usd")
        usage["num_turns"] = final.get("num_turns")
    elif cli == "agy":
        # Confirmed live (a real headless code-reviewer dispatch during
        # Final Verification): agy's terminal result event really does
        # carry `usage: {input_tokens, output_tokens, total_tokens,
        # thinking_tokens, cache_read_tokens}` and a top-level `num_turns`
        # -- this was a VERIFY guess before that run; the fallback keys
        # (prompt_tokens/completion_tokens, cost_usd/cost) stay defensive
        # since only the confirmed names were actually observed. No cost
        # field was present in that same real response, so cost_usd stays
        # a VERIFY guess.
        raw = final.get("usage") if isinstance(final.get("usage"), dict) else {}
        usage["input_tokens"] = raw.get("input_tokens", raw.get("prompt_tokens"))
        usage["output_tokens"] = raw.get("output_tokens", raw.get("completion_tokens"))
        usage["total_tokens"] = raw.get("total_tokens")
        usage["cost_usd"] = final.get("cost_usd", final.get("cost"))
        usage["num_turns"] = final.get("num_turns")
    elif cli in ("codex", "copilot"):
        usage["total_tokens"] = _usage_from_text(stdout)
    return usage


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


def normalize_optional_nulls(result, schema):
    """Drop top-level keys whose value is `null` when that key isn't in the
    schema's `required` list. Confirmed live: under OpenAI's structured-
    outputs strict mode, codex must supply every property from its
    (codex-only, see codex_strict_schema()) transformed schema, so an
    optional field it has nothing to report for comes back as an explicit
    `null` rather than simply missing -- e.g. round 1's `previous_issues`.
    Our canonical schemas define that field's *value*, when present, as an
    array, so validate() would otherwise reject the null. Treating an
    explicit optional-field null the same as "omitted" keeps every CLI's
    result the same shape for both validate() and the Team Lead's merge,
    and is a no-op for any CLI that simply omits the key instead."""
    if not isinstance(result, dict) or not isinstance(schema, dict):
        return result
    required = set(schema.get("required") or [])
    return {k: v for k, v in result.items() if not (v is None and k not in required)}


def validate(result, schema):
    if not isinstance(result, dict):
        return "result is not a JSON object"
    return validate_schema(result, schema, "")


def update_status(runs_dir, run, fields):
    """Merge fields into <runs_dir>/status.json under this run's name."""
    path = runs_dir / "status.json"
    with open(runs_dir / ".status.lock", "w", encoding="utf-8") as lock:
        _lock_file(lock)
        try:
            try:
                status = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                status = {}
            status.setdefault(run, {}).update(fields)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
            tmp.replace(path)
        finally:
            _unlock_file(lock)


def now():
    return time.strftime("%H:%M:%S")


def _terminate_pid_group(pid):
    """Send the initial terminate signal to pid's whole process group/tree
    (POSIX SIGTERM, Windows `taskkill /T /F` which is already a hard kill).
    Returns False if there was nothing there to signal."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return False
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return False
    return True


def _hard_kill_pid_group(pid):
    if os.name == "nt":
        return  # the taskkill /F above was already the hard kill
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except ProcessLookupError:
        pass


def kill_pid_group(pid, timeout=GRACEFUL_KILL_TIMEOUT):
    """Kill pid's whole process group/tree from outside — used by `cancel`,
    which (unlike `main`'s own kill_process_tree) has no live Popen handle to
    `wait()` on, so it polls for the group to disappear instead."""
    if not _terminate_pid_group(pid):
        return False
    if os.name == "nt":
        return True
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return True
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.2)
    _hard_kill_pid_group(pid)
    return True


SANDBOX_ERROR_SIGNATURES = [
    (re.compile(r"ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT|network is unreachable", re.I),
     "the host sandbox likely blocks network — the child CLI can't reach its API"),
    (re.compile(r"\bEACCES\b|permission denied.*\.(claude|codex|gemini|copilot)", re.I),
     "the host sandbox likely blocks writing to the child CLI's config/auth directory"),
    (re.compile(r"not logged in|no credentials|unauthenticated|please (run|sign in)|401 unauthorized", re.I),
     "the child CLI doesn't appear to be logged in"),
]


def classify_sandbox_error(text):
    """A plain-language hint prefix for a raw child error, when it matches a
    typical sandbox-failure signature (6.3) — None otherwise. Best-effort
    pattern matching, not a guarantee; VERIFY against real sandboxed runs."""
    for pattern, hint in SANDBOX_ERROR_SIGNATURES:
        if pattern.search(text or ""):
            return hint
    return None


NETWORK_CHECK_HOSTS = {
    # VERIFY: these are each CLI's most likely API host based on its
    # documented auth/provider, not confirmed from CLI docs — a false
    # negative here (host reachable but this isn't the real endpoint) is
    # possible; `doctor`'s other checks (auth status) are the stronger signal.
    "claude": ("api.anthropic.com", 443),
    "codex": ("api.openai.com", 443),
    "agy": ("generativelanguage.googleapis.com", 443),
    "copilot": ("api.github.com", 443),
}


def _network_check_target(cli):
    """NETWORK_CHECK_HOSTS[cli], unless CREWBENCH_NETWORK_CHECK_OVERRIDE_<CLI>
    (e.g. "127.0.0.1:54321") is set — for tests, to check the real
    reachable/unreachable logic without depending on live internet access;
    the production path is unchanged when unset."""
    override = os.environ.get(f"CREWBENCH_NETWORK_CHECK_OVERRIDE_{cli.upper()}")
    if override and ":" in override:
        host, port = override.rsplit(":", 1)
        return host, int(port)
    return NETWORK_CHECK_HOSTS[cli]


def _network_ok(cli, timeout=3):
    host, port = _network_check_target(cli)
    try:
        socket.create_connection((host, port), timeout=timeout).close()
        return True, f"reached {host}:{port}"
    except OSError as exc:
        return False, f"could not reach {host}:{port} ({exc})"


def _auth_check(cli, cli_path):
    """(logged_in, detail) using the cheapest non-interactive status command
    each CLI offers (ground rule: use one if it exists, else a minimal ping).
    Confirmed live on this machine: `claude auth status --json` (loggedIn
    bool + email) and `codex login status` (exit 0 + "Logged in as ..." /
    exit non-zero otherwise — the failure exit code itself is VERIFY, only
    the success case was observed). agy and copilot have no dedicated
    auth-status subcommand documented in --help as of writing — VERIFY:
    agy falls back to `agy models`, a real (cheap) network+auth call; copilot
    falls back to checking for a stored credential/token file, which is
    weaker evidence than an actual call and can't be tightened without
    spending a real prompt."""
    try:
        if cli == "claude":
            r = subprocess.run(cli_argv_prefix(cli_path) + ["auth", "status", "--json"],
                                capture_output=True, text=True, timeout=15)
            data = json.loads(r.stdout or "{}")
            return bool(data.get("loggedIn")), (data.get("email") or r.stdout.strip() or r.stderr.strip())
        if cli == "codex":
            r = subprocess.run(cli_argv_prefix(cli_path) + ["login", "status"],
                                capture_output=True, text=True, timeout=15)
            return r.returncode == 0, (r.stdout or r.stderr).strip()
        if cli == "agy":
            r = subprocess.run(cli_argv_prefix(cli_path) + ["models"], capture_output=True, text=True, timeout=20)
            ok = r.returncode == 0 and bool(r.stdout.strip())
            detail = (r.stdout or r.stderr).strip().splitlines()
            return ok, (detail[0] if detail else "no output")
        if cli == "copilot":
            has_token = any(os.environ.get(v) for v in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"))
            config_dir = Path(os.path.expanduser(CONFIG_DIRS["copilot"]))
            has_stored = (config_dir / "config.json").exists()
            ok = has_token or has_stored
            detail = ("found a token env var or stored credential (best-effort check only — "
                      "VERIFY, no dedicated status command found)" if ok else
                      "no token env var or stored credential found — VERIFY, this check can't "
                      "positively confirm login without a real prompt call")
            return ok, detail
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
        return False, str(exc)
    return False, "no auth check implemented for this CLI"


def _dir_writable(path):
    """True if `path` is already a writable directory, or doesn't exist yet
    but could be (its nearest existing ancestor is a writable directory).
    A CLI's config dir is commonly created lazily on first login/run, so
    "doesn't exist yet" alone isn't evidence it can't be written to --
    real bug found running `doctor` for real on a fresh machine/CI runner
    that had never logged into a given CLI: the old check required the
    directory to already exist, which fails for any CLI whose config dir
    the user's shell hasn't created yet even though login would succeed."""
    p = Path(path)
    if p.exists():
        return p.is_dir() and os.access(p, os.W_OK)
    for ancestor in p.parents:
        if ancestor.exists():
            return ancestor.is_dir() and os.access(ancestor, os.W_OK)
    return False


def cmd_doctor(argv):
    """`crewbench_dispatch.py doctor --cli <cli> [--cwd <dir>]` — preflight
    for delegating to <cli> from inside a (possibly sandboxed) host: is it
    installed, is its config dir writable, can it reach its API, is it
    logged in. Prints a JSON report and exits 0 only if every check passed."""
    p = argparse.ArgumentParser(prog="crewbench_dispatch.py doctor")
    p.add_argument("--cli", required=True, choices=["claude", "agy", "codex", "copilot"])
    p.add_argument("--cwd", default=None)
    args = p.parse_args(argv)
    report = {"cli": args.cli, "installed": False, "version": None,
              "config_dir": None, "config_dir_writable": None,
              "network_ok": None, "network_detail": None,
              "logged_in": None, "auth_detail": None, "ok": False, "errors": []}
    cli_path = resolve_cli_path(args.cli)
    if not cli_path:
        report["errors"].append(f"{args.cli} is not installed or not on PATH")
        print(json.dumps(report, indent=2))
        sys.exit(1)
    report["installed"] = True
    try:
        v = subprocess.run(cli_argv_prefix(cli_path) + ["--version"], capture_output=True, text=True, timeout=10)
        report["version"] = (v.stdout or v.stderr).strip()
    except (OSError, subprocess.SubprocessError) as exc:
        report["errors"].append(f"could not read {args.cli}'s version: {exc}")

    config_dir = os.path.expanduser(CONFIG_DIRS[args.cli])
    report["config_dir"] = config_dir
    writable = _dir_writable(config_dir)
    report["config_dir_writable"] = writable
    if not writable:
        report["errors"].append(
            f"{args.cli}'s config dir ({config_dir}) isn't writable from here (and can't be "
            "created) — a headless child needs to read (and sometimes refresh) its login there")

    net_ok, net_detail = _network_ok(args.cli)
    report["network_ok"], report["network_detail"] = net_ok, net_detail
    if not net_ok:
        report["errors"].append(
            f"host sandbox blocks network — the {args.cli} child can't reach its API ({net_detail})")

    logged_in, auth_detail = _auth_check(args.cli, cli_path)
    report["logged_in"], report["auth_detail"] = logged_in, auth_detail
    if not logged_in:
        report["errors"].append(
            f"{args.cli} does not appear to be logged in ({auth_detail}) — run its login command "
            "outside the sandbox, then retry")

    report["ok"] = not report["errors"]
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["ok"] else 1)


def _read_status(runs_dir):
    try:
        return json.loads((runs_dir / "status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def cmd_start(argv):
    """`crewbench_dispatch.py start <the same flags as the foreground form>`
    — launches the run fully detached and returns immediately. The detached
    process is just another `main()` invocation (same code path, so results
    land in exactly the same files); only the launch itself differs."""
    args = build_arg_parser().parse_args(argv)
    args.cwd = os.path.abspath(args.cwd) if args.cwd else os.getcwd()
    runs_dir, run = resolve_run_paths(args)
    runs_dir.mkdir(parents=True, exist_ok=True)
    launcher_log = runs_dir / f"{run}.launcher.log"
    cmd = [sys.executable, str(Path(__file__).resolve())] + argv
    popen_kwargs = {}
    if os.name == "nt":
        popen_kwargs["creationflags"] = (subprocess.CREATE_NEW_PROCESS_GROUP
                                          | getattr(subprocess, "DETACHED_PROCESS", 0))
    else:
        popen_kwargs["start_new_session"] = True
    with open(launcher_log, "w", encoding="utf-8") as lf:
        proc = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, **popen_kwargs)
    update_status(runs_dir, run, {"schema_version": SCHEMA_VERSION, "state": "starting", "launcher_pid": proc.pid})
    print(json.dumps({
        "run": run, "pid": proc.pid,
        "log_file": str(runs_dir / f"{run}.log"),
        "status_file": str(runs_dir / "status.json"),
    }, indent=2))


def cmd_wait(argv):
    """`crewbench_dispatch.py wait --task-dir <dir> --run <run> [--run <run2>] --max-seconds <n>`
    — blocks (below the smallest host shell-tool timeout you've found for
    your host) then reports each named run's current status.json entry, plus
    its full envelope for any that already finished. Call repeatedly until
    every run is done/failed."""
    p = argparse.ArgumentParser(prog="crewbench_dispatch.py wait")
    p.add_argument("--task-dir", required=True)
    p.add_argument("--run", action="append", dest="runs", required=True)
    p.add_argument("--max-seconds", type=float, default=240)
    p.add_argument("--poll-interval", type=float, default=2.0)
    args = p.parse_args(argv)
    runs_dir = Path(args.task_dir) / "runs"
    deadline = time.time() + args.max_seconds
    statuses = {}
    while True:
        status = _read_status(runs_dir)
        statuses = {r: status.get(r, {"state": "unknown"}) for r in args.runs}
        if all(statuses[r].get("state") in ("done", "failed") for r in args.runs):
            break
        if time.time() >= deadline:
            break
        time.sleep(args.poll_interval)
    envelopes = {}
    for r in args.runs:
        result_file = runs_dir / f"{r}.result.json"
        if result_file.exists():
            try:
                envelopes[r] = json.loads(result_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                envelopes[r] = None
    all_finished = all(statuses[r].get("state") in ("done", "failed") for r in args.runs)
    print(json.dumps({"runs": statuses, "envelopes": envelopes, "all_finished": all_finished}, indent=2))
    sys.exit(0 if all_finished else 1)


def cmd_cancel(argv):
    """`crewbench_dispatch.py cancel --task-dir <dir> --run <run>` — kills
    that run's process group (both the CLI child and, if `start` launched it,
    the launcher) and marks it `failed` in status.json."""
    p = argparse.ArgumentParser(prog="crewbench_dispatch.py cancel")
    p.add_argument("--task-dir", required=True)
    p.add_argument("--run", required=True)
    args = p.parse_args(argv)
    runs_dir = Path(args.task_dir) / "runs"
    entry = _read_status(runs_dir).get(args.run, {})
    killed_any = False
    for key in ("pid", "launcher_pid"):
        pid = entry.get(key)
        if pid:
            killed_any = kill_pid_group(pid) or killed_any
    update_status(runs_dir, args.run, {"state": "failed", "error": "cancelled by user",
                                       "finished_at": now_iso()})
    print(json.dumps({"run": args.run, "cancelled": killed_any}, indent=2))


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--role", required=True, choices=ROLES)
    p.add_argument("--cli", required=True, choices=["claude", "agy", "codex", "copilot"])
    p.add_argument("--model", required=True)
    p.add_argument("--effort", default="medium", help='low|medium|high|xhigh|max, or "none" to omit')
    p.add_argument("--handoff", required=True, help="file with the task hand-off")
    p.add_argument("--task-dir", default=None,
                   help=".crewbench/tasks/<task-id> — if given, run artifacts go under "
                        "<task-dir>/runs/<role>-r<round>.* instead of next to --handoff")
    p.add_argument("--round", type=int, default=1, help="fix-loop round number (only used with --task-dir)")
    p.add_argument("--timeout", type=int, default=1800, help="seconds (default 1800)")
    p.add_argument("--skip-permissions", action="store_true",
                   help="run the child with permission checks skipped (ignored for code-reviewer)")
    p.add_argument("--cwd", default=None,
                   help="working directory for the child CLI and git snapshots "
                        "(default: the directory this script is run from) — pass the "
                        "task's worktree path for Phase 5 worktree isolation")
    return p


def resolve_run_paths(args):
    """(runs_dir, run) for this invocation's artifacts — shared by the
    foreground path and `start`, so a detached launch names its files
    identically to a foreground one."""
    handoff_path = Path(args.handoff)
    if args.task_dir:
        runs_dir = Path(args.task_dir) / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)
        run = f"{args.role}-r{args.round}"
    else:
        # Back-compat: no --task-dir means the pre-Phase-4 layout, everything
        # named after --handoff itself.
        runs_dir = handoff_path.resolve().parent
        run = handoff_path.stem
    return runs_dir, run


def main(argv=None):
    if os.environ.get("CREWBENCH_ROLE"):
        raise SystemExit(
            "crewbench_dispatch.py refuses to run: CREWBENCH_ROLE="
            f"{os.environ['CREWBENCH_ROLE']!r} is already set in this process's environment, "
            "meaning this is itself a crew role's child process. A crew member must never "
            "dispatch another crew or invoke crewbench skills — only the Team Lead does that.")
    args = build_arg_parser().parse_args(argv)
    args.cwd = os.path.abspath(args.cwd) if args.cwd else os.getcwd()

    handoff_path = Path(args.handoff)
    runs_dir, run = resolve_run_paths(args)
    task_id = Path(args.task_dir).name if args.task_dir else None
    out_path = runs_dir / f"{run}.result.json"
    raw_path = runs_dir / f"{run}.raw.txt"
    log_path = runs_dir / f"{run}.log"
    envelope = {"schema_version": SCHEMA_VERSION,
                "role": args.role, "cli": args.cli, "model": args.model, "effort": args.effort,
                "skip_permissions": args.skip_permissions and args.role not in READ_ONLY,
                "ok": False, "exit_code": None, "duration_s": None, "result": None, "usage": None,
                "permission_denials": [], "error": None, "session_id": None, "resume_command": None,
                "result_file": str(out_path), "log_file": str(log_path), "raw_output_file": str(raw_path)}

    def finish():
        out_path.write_text(json.dumps(envelope, indent=2) + "\n", encoding="utf-8")
        update_status(runs_dir, run, {"state": "done" if envelope["ok"] else "failed",
                                      "finished_at": now_iso(),
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
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    prompt = build_prompt(args.role, args.cli, handoff_path.read_text(encoding="utf-8"), schema,
                          args.skip_permissions and args.role not in READ_ONLY)
    prompt_path = runs_dir / f"{run}.prompt.md"
    prompt_path.write_text(prompt, encoding="utf-8")
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
                                text=True, encoding="utf-8", errors="replace", bufsize=1, cwd=args.cwd,
                                env=child_env(args.cli, args.role, task_id), **popen_kwargs)

    def kill_process_tree(proc):
        """Kill the whole process group/tree, not just the direct child (the
        CLIs spawn node/helper processes that would otherwise survive)."""
        if not _terminate_pid_group(proc.pid):
            return
        if os.name == "nt":
            return
        hard_timer = threading.Timer(GRACEFUL_KILL_TIMEOUT, _hard_kill_pid_group, args=(proc.pid,))
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
            # The child may exit (or simply close its stdin) before reading
            # all of this, especially a fast-failing one -- confirmed live
            # on Windows CI, where writing to an already-closed pipe raises
            # BrokenPipeError immediately rather than tolerating it the way
            # POSIX generally does. Not our failure to report: whatever the
            # child did or didn't read, parse_output()/validate() below are
            # what actually decide if the run succeeded.
            try:
                proc.stdin.write(stdin)
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass

        def kill():
            timed_out.set()
            kill_process_tree(proc)

        timer = threading.Timer(remaining, kill)
        timer.start()
        stderr_thread = None
        if proc.stderr is not None:
            def drain_stderr():
                with open(stderr_path, "a", encoding="utf-8") as f:
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
        stderr_parts.append(Path(stderr_path).read_text(encoding="utf-8") if Path(stderr_path).exists() else "")
        return result_code

    with tempfile.TemporaryDirectory() as tmp, open(log_path, "w", buffering=1, encoding="utf-8") as log:
        cmd, stdin, last_message = build_command(args, prompt, prompt_path, schema_path, tmp,
                                                 timeout_s=deadline - time.time())
        cmd[0:1] = cli_argv_prefix(cli_path)
        try:
            check_argv_size(cmd)
        except ValueError as exc:
            envelope["error"] = str(exc)
            finish()
        stderr_path = Path(tmp) / "stderr.txt"
        log.write(f"[{now()}] {args.role} on {args.cli} ({args.model}, effort {args.effort})\n")
        for warning in warnings:
            log.write(f"[{now()}] warning: {warning}\n")
        update_status(runs_dir, run, {"schema_version": SCHEMA_VERSION,
                                      "role": args.role, "cli": args.cli, "model": args.model,
                                      "effort": args.effort, "state": "running",
                                      "started_at": now_iso(),
                                      "log_file": str(log_path), "session_id": None})
        print(f"crewbench: {run} running on {args.cli} — live log: tail -f {log_path}",
              file=sys.stderr, flush=True)
        start = time.time()
        git_before = git_state(args.cwd)
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
            resume_prompt_path = runs_dir / f"{run}.resume{resume_n + 1}.prompt.md"
            resume_prompt_path.write_text(follow_up, encoding="utf-8")
            cmd, stdin, _ = build_command(args, follow_up, resume_prompt_path, schema_path, tmp,
                                          conversation=stream.session_id,
                                          timeout_s=deadline - time.time())
            cmd[0:1] = cli_argv_prefix(cli_path)
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
        envelope["usage"] = extract_usage(args.cli, stream, stdout, envelope["duration_s"])
        raw_path.write_text(f"$ {cmd[0]} ...\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n",
                            encoding="utf-8")
        result, denials, error = parse_output(args.cli, stream, stdout, last_message)
        result = normalize_optional_nulls(result, schema)
        if stream.denied_commands:
            denials = [{"action": "command", "command": c} for c in dict.fromkeys(stream.denied_commands)]
        log.write(f"[{now()}] exit {code} after {envelope['duration_s']}s\n")

    envelope["permission_denials"] = denials
    envelope["result"] = result
    git_warnings, git_notes = git_changes(args.role, git_before, git_state(args.cwd))
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
        tail_text = " / ".join(short(t, 300) for t in tail)
        hint = classify_sandbox_error(problem + " " + tail_text)
        if hint:
            problem = f"{hint}: {problem}"
        problem += "" if not tail else " | " + tail_text
    envelope["error"] = problem
    envelope["ok"] = problem is None
    finish()


SUBCOMMANDS = {"start": cmd_start, "wait": cmd_wait, "cancel": cmd_cancel, "doctor": cmd_doctor}


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in SUBCOMMANDS:
        SUBCOMMANDS[sys.argv[1]](sys.argv[2:])
    else:
        main(sys.argv[1:])
