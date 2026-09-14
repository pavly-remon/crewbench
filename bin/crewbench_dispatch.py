#!/usr/bin/env python3
"""Run one crewbench role on a headless CLI and return a JSON result envelope.

Usage:
  python3 <root>/bin/crewbench_dispatch.py --role developer --cli agy \
      --model gemini-3.8-flash --effort medium --handoff .crewbench/runs/dev-1.md

The role brief, tool limits and result schema are added automatically; the
handoff file only needs the task itself. Child agents never run with
permission checks disabled: each CLI is started sandboxed or with a scoped
tool set, and anything the child can't do is reported under "blocked".

Prints the envelope as JSON on stdout and writes it next to the handoff file
(<handoff>.result.json, raw output in <handoff>.raw.txt). Exit code is 0 when
the role returned a valid result, 1 otherwise.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

ROLES = {
    "developer": "developer.md",
    "tester": "tester.md",
    "code-reviewer": "code-reviewer.md",
    "ui-ux": "ui-ux-designer.md",
}

LIMITS = {
    "developer": "You may read and edit files in the project and run shell commands.",
    "tester": "You may read files, add or edit test files, and run shell commands. Do not change non-test source code.",
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
NO_EFFORT = {"", "none", "n/a"}


def strip_frontmatter(text):
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def agy_allowed_commands():
    """Shell commands the user's agy settings pre-approve (headless agy aborts on anything else)."""
    settings = Path.home() / ".gemini" / "antigravity-cli" / "settings.json"
    try:
        rules = json.loads(settings.read_text()).get("permissions", {}).get("allow", [])
    except (OSError, ValueError):
        return []
    return [r[len("command("):-1] for r in rules if r.startswith("command(") and r.endswith(")")]


def limits_for(role, cli):
    text = LIMITS[role]
    if cli == "agy" and role not in READ_ONLY and role != "ui-ux":
        allowed = agy_allowed_commands()
        text += (
            "\n\nShell commands are restricted in this run: running any command not on the "
            "list below ends your run immediately with no result. Use your file read/edit "
            "tools instead of shell commands wherever possible. Do not run any other "
            "command — list it under \"blocked\" instead. Allowed command patterns "
            "(* is a wildcard): " + (", ".join(f"`{c}`" for c in allowed) if allowed else "none"))
    if cli == "copilot" and role in ("developer", "tester"):
        text += "\n\nShell commands are not available in this run; list any you needed under \"blocked\"."
    return text


def build_prompt(role, cli, handoff, schema):
    brief = strip_frontmatter((ROOT / "agents" / ROLES[role]).read_text())
    return "\n\n".join([
        brief.strip(),
        "## Limits\n\n" + limits_for(role, cli),
        "## Hand-off from the Team Lead\n\n" + handoff.strip(),
        "## How to report\n\n"
        "You are running non-interactively as part of a crewbench team. Don't ask "
        "questions; put ambiguities in your result. If an action you need is denied "
        "or blocked by the sandbox, don't try to work around it — list it under "
        "\"blocked\" and continue with what you can do.\n\n"
        "Your final answer must be a single JSON object matching this JSON Schema, "
        "with no text before or after it:\n\n" + json.dumps(schema, indent=2),
    ])


def build_command(args, prompt, schema_path, tmp):
    role, model, effort = args.role, args.model, args.effort
    has_effort = effort.lower() not in NO_EFFORT
    if args.cli == "claude":
        cmd = ["claude", "-p", "--model", model, "--output-format", "json",
               "--json-schema", schema_path.read_text(),
               "--tools", CLAUDE_TOOLS[role], "--strict-mcp-config",
               # plan keeps the reviewer read-only; auto has a classifier review
               # every other action instead of skipping approval.
               "--permission-mode", "plan" if role in READ_ONLY else "auto"]
        if has_effort:
            cmd += ["--effort", effort]
        return cmd, prompt, None
    if args.cli == "agy":
        cmd = ["agy", "--model", model, "--sandbox",
               "--mode", "plan" if role in READ_ONLY else "accept-edits",
               "--output-format", "json", "--json-schema", str(schema_path),
               "--print-timeout", f"{args.timeout}s"]
        if has_effort:
            cmd += ["--effort", effort]
        return cmd + [f"-p={prompt}"], None, None
    if args.cli == "codex":
        last = Path(tmp) / "last-message.txt"
        cmd = ["codex", "exec", "-m", model,
               "-s", "read-only" if role in READ_ONLY else "workspace-write",
               "--output-schema", str(schema_path), "-o", str(last)]
        if has_effort:
            cmd += ["-c", f"model_reasoning_effort={effort}"]
        return cmd + ["-"], prompt, last
    if args.cli == "copilot":
        # Copilot has no per-run sandbox flag, so shell stays denied.
        cmd = ["copilot", "-s", "--no-ask-user", "--model", model,
               "--deny-tool=shell", "--deny-tool=url"]
        if role not in READ_ONLY:
            cmd += ["--allow-tool=write"]
        if has_effort:
            cmd += ["--effort", effort]
        return cmd + ["-p", prompt], None, None
    raise SystemExit(f"unknown cli: {args.cli}")


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


def parse_output(cli, stdout, last_message_file):
    """Return (result, permission_denials, error)."""
    if cli in ("claude", "agy"):
        envelope = extract_json(stdout)
        if envelope is None:
            return None, [], "no JSON in output"
        denials = envelope.get("permission_denials") or envelope.get("denied_actions") or []
        if isinstance(envelope.get("structured_output"), dict):
            return envelope["structured_output"], denials, None
        if envelope.get("is_error") or envelope.get("status") not in (None, "SUCCESS"):
            return None, denials, str(envelope.get("result") or envelope.get("response") or envelope.get("status"))
        text = envelope.get("result") or envelope.get("response") or ""
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


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--role", required=True, choices=ROLES)
    p.add_argument("--cli", required=True, choices=["claude", "agy", "codex", "copilot"])
    p.add_argument("--model", required=True)
    p.add_argument("--effort", default="medium", help='low|medium|high|xhigh|max, or "none" to omit')
    p.add_argument("--handoff", required=True, help="file with the task hand-off")
    p.add_argument("--timeout", type=int, default=1800, help="seconds (default 1800)")
    args = p.parse_args()

    handoff_path = Path(args.handoff)
    out_path = handoff_path.with_suffix(".result.json")
    raw_path = handoff_path.with_suffix(".raw.txt")
    envelope = {"role": args.role, "cli": args.cli, "model": args.model, "effort": args.effort,
                "ok": False, "exit_code": None, "duration_s": None, "result": None,
                "permission_denials": [], "error": None,
                "result_file": str(out_path), "raw_output_file": str(raw_path)}

    def finish():
        out_path.write_text(json.dumps(envelope, indent=2) + "\n")
        print(json.dumps(envelope, indent=2))
        sys.exit(0 if envelope["ok"] else 1)

    if shutil.which(args.cli) is None:
        envelope["error"] = f"{args.cli} is not installed or not on PATH"
        finish()

    schema_path = ROOT / "schemas" / f"{args.role}.json"
    schema = json.loads(schema_path.read_text())
    prompt = build_prompt(args.role, args.cli, handoff_path.read_text(), schema)

    with tempfile.TemporaryDirectory() as tmp:
        cmd, stdin, last_message = build_command(args, prompt, schema_path, tmp)
        start = time.time()
        try:
            proc = subprocess.run(cmd, input=stdin, capture_output=True, text=True,
                                  timeout=args.timeout + 60, cwd=os.getcwd())
            stdout, stderr, code = proc.stdout, proc.stderr, proc.returncode
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr, code = f"timed out after {args.timeout}s", None
        envelope["duration_s"] = round(time.time() - start, 1)
        envelope["exit_code"] = code
        raw_path.write_text(f"$ {' '.join(cmd[:1])} ...\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}\n")
        result, denials, error = parse_output(args.cli, stdout, last_message)

    envelope["permission_denials"] = denials
    envelope["result"] = result
    problem = error or validate(result, schema)
    if problem is None and code not in (0, None):
        problem = f"{args.cli} exited with code {code}"
    if problem and args.cli == "agy" and denials:
        actions = sorted({d.get("action", "?") for d in denials if isinstance(d, dict)})
        problem += (" | headless agy denied: " + ", ".join(actions) + ". agy only runs "
                    "actions allowed under permissions.allow in ~/.gemini/antigravity-cli/settings.json"
                    " (e.g. " + ", ".join(f"{a}(<target>)" for a in actions) + ")")
    if problem:
        tail = (stderr or stdout or "").strip().splitlines()[-5:]
        envelope["error"] = problem + ("" if not tail else " | " + " / ".join(tail))
    envelope["ok"] = problem is None
    finish()


if __name__ == "__main__":
    main()
