#!/usr/bin/env python3
"""Bump the version in all three plugin manifests together.

Usage:
  python3 scripts/bump_version.py <new-version>

Updates plugin.json, .claude-plugin/plugin.json and .codex-plugin/
plugin.json's "version" field to <new-version> (must look like
`MAJOR.MINOR.PATCH`), then runs check_manifests.py as a sanity check.
Stdlib only.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


def main():
    if len(sys.argv) != 2 or not VERSION_RE.match(sys.argv[1]):
        print("usage: bump_version.py <new-version>  (e.g. 3.0.0)", file=sys.stderr)
        return 1
    new_version = sys.argv[1]

    old_versions = set()
    for rel in MANIFESTS:
        path = ROOT / rel
        text = path.read_text()
        try:
            data = json.loads(text)
        except ValueError as exc:
            print(f"error: could not parse {rel}: {exc}", file=sys.stderr)
            return 1
        old_versions.add(data.get("version"))
        data["version"] = new_version
        # Preserve key order and trailing newline; json.dumps with indent=2
        # matches this repo's existing manifest formatting.
        path.write_text(json.dumps(data, indent=2) + "\n")

    print(f"bumped {', '.join(sorted(old_versions - {None}))} -> {new_version} in: " + ", ".join(MANIFESTS))

    check = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_manifests.py")])
    return check.returncode


if __name__ == "__main__":
    sys.exit(main())
