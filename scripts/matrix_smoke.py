#!/usr/bin/env python3
"""Real, local-only smoke test for the host x role-CLI compatibility matrix
(Phase 6, item 6.6). NEVER run this in CI: it launches real CLI processes,
spends real API/CLI usage across whichever of claude/codex/agy/copilot are
installed and logged in, and needs a live login for each. Run it by hand:

    python3 scripts/matrix_smoke.py [--role-cli claude,codex,...]

What it does, for every **installed** host CLI:

1. Creates a tiny throwaway git repo (a function with an off-by-one bug and
   one failing test for it).
2. Runs `doctor` for every installed **role** CLI from inside that host's
   own shell/sandbox — for `codex` as host this is free (`codex sandbox --
   ...`, no model call); for `claude`/`agy`/`copilot` as host it costs one
   small real prompt asking that CLI to run the doctor command and print its
   JSON output verbatim (VERIFY: the exact non-interactive invocation for
   asking a host to run a shell command and report its output is inferred
   from each CLI's own `-p`/`exec` flags documented in `bin/
   crewbench_dispatch.py`'s `build_command`, not confirmed live for this
   purpose specifically).
3. Runs one real headless `code-reviewer` dispatch (read-only, the CLI's
   cheap tier, low effort — cheapest real check available) against the
   throwaway repo for each installed role CLI, and checks a valid,
   `ok: true` envelope with at least one issue comes back.
4. Skips any host or role CLI that isn't installed or doesn't look logged
   in (via `doctor`), with a clear reason — it never fails the whole run for
   a missing CLI.

Prints a result table at the end. Update `docs/compatibility.md`'s matrix
by hand from this script's output; it is not run or parsed automatically.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DISPATCH = ROOT / "bin" / "crewbench_dispatch.py"
ALL_CLIS = ["claude", "codex", "agy", "copilot"]

# Cheapest tier per CLI (mirrors config/defaults.json's `cheap` tier), used
# for the one real code-reviewer dispatch below to keep cost minimal.
CHEAP_TIER = {"claude": "sonnet", "codex": "gpt-5.6-terra", "agy": "gemini-3.8-flash",
             "copilot": "claude-sonnet-5"}

BUGGY_SOURCE = (
    "def add_one(n):\n"
    "    return n  # bug: should be n + 1\n"
)
BUGGY_TEST = (
    "from calc import add_one\n\n"
    "def test_add_one():\n"
    "    assert add_one(1) == 2\n"
)


def installed(cli):
    return shutil.which(cli) is not None


def make_throwaway_repo():
    tmp = Path(tempfile.mkdtemp(prefix="crewbench-matrix-smoke-"))
    (tmp / "calc.py").write_text(BUGGY_SOURCE)
    (tmp / "test_calc.py").write_text(BUGGY_TEST)
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.email", "smoke@test"], cwd=tmp, check=True)
    subprocess.run(["git", "config", "user.name", "smoke"], cwd=tmp, check=True)
    subprocess.run(["git", "add", "-A"], cwd=tmp, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=tmp, check=True)
    return tmp


def run_doctor_from_host(host, role_cli, repo):
    """(ok, detail) — run `doctor --cli role_cli` from inside `host`'s own
    shell/sandbox. Free for codex (`codex sandbox --`); a small real prompt
    for the others (VERIFY exact invocation, see module docstring)."""
    doctor_cmd = f"python3 {DISPATCH} doctor --cli {role_cli}"
    try:
        if host == "codex":
            r = subprocess.run(["codex", "sandbox", "--", "python3", str(DISPATCH),
                                "doctor", "--cli", role_cli],
                                cwd=repo, capture_output=True, text=True, timeout=60)
            return r.returncode == 0, (r.stdout or r.stderr).strip()[-500:]
        prompt = (f"Run this exact shell command and print only its stdout, "
                  f"nothing else: {doctor_cmd}")
        if host == "claude":
            r = subprocess.run(["claude", "-p", prompt, "--permission-mode", "bypassPermissions",
                                "--model", "sonnet"], cwd=repo, capture_output=True, text=True, timeout=90)
        elif host == "agy":
            r = subprocess.run(["agy", "-p", prompt, "--dangerously-skip-permissions",
                                "--model", "gemini-3.8-flash"],
                                cwd=repo, capture_output=True, text=True, timeout=90)
        elif host == "copilot":
            r = subprocess.run(["copilot", "-p", prompt, "--allow-all-tools", "-s"],
                                cwd=repo, capture_output=True, text=True, timeout=90)
        else:
            return False, f"unknown host {host!r}"
        ok = r.returncode == 0 and '"ok": true' in (r.stdout or "")
        return ok, (r.stdout or r.stderr).strip()[-500:]
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)


def run_real_code_reviewer(role_cli, repo):
    handoff = repo / "handoff.md"
    handoff.write_text(
        "Task: review calc.py for correctness bugs.\n"
        "Acceptance criteria: flag the off-by-one bug in add_one.\n")
    cmd = [sys.executable, str(DISPATCH), "--role", "code-reviewer", "--cli", role_cli,
           "--model", CHEAP_TIER[role_cli], "--effort", "low",
           "--handoff", str(handoff), "--timeout", "300"]
    try:
        r = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=320)
    except subprocess.TimeoutExpired:
        return False, "dispatch script itself timed out"
    try:
        envelope = json.loads(r.stdout)
    except ValueError:
        return False, f"no valid envelope on stdout: {r.stdout[-300:]}"
    if not envelope.get("ok"):
        return False, envelope.get("error")
    issues = (envelope.get("result") or {}).get("issues") or []
    if not issues:
        return False, "envelope ok but no issues found — reviewer may have missed the seeded bug"
    return True, f"{len(issues)} issue(s) found, e.g. {issues[0].get('summary', issues[0])!r:.120}"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--role-cli", default=",".join(ALL_CLIS),
                   help="comma-separated role CLIs to test (default: all installed)")
    args = p.parse_args()
    role_clis = [c.strip() for c in args.role_cli.split(",") if c.strip()]

    hosts = [c for c in ALL_CLIS if installed(c)]
    if not hosts:
        print("no host CLI is installed on this machine — nothing to smoke test")
        return 1

    rows = []
    for host in hosts:
        repo = make_throwaway_repo()
        for role_cli in role_clis:
            if not installed(role_cli):
                rows.append((host, role_cli, "skipped", "not installed"))
                continue
            doctor_ok, doctor_detail = run_doctor_from_host(host, role_cli, repo)
            if not doctor_ok:
                rows.append((host, role_cli, "doctor failed", doctor_detail))
                continue
            review_ok, review_detail = run_real_code_reviewer(role_cli, repo)
            rows.append((host, role_cli,
                        "verified (real)" if review_ok else "review failed", review_detail))

    width = max(len(f"{r[0]}/{r[1]}") for r in rows) + 2
    print(f"{'host/role-cli'.ljust(width)} {'status'.ljust(18)} detail")
    for host, role_cli, status, detail in rows:
        print(f"{(host + '/' + role_cli).ljust(width)} {status.ljust(18)} {detail}")

    failures = [r for r in rows if r[2] not in ("verified (real)", "skipped")]
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
