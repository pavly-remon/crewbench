#!/usr/bin/env python3
"""Fail if the three plugin manifests' version or description have diverged.

Run in CI (see .github/workflows/ci.yml) and by `scripts/bump_version.py`
after it updates all three, as a cheap sanity check. Stdlib only.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]


def main():
    loaded = {}
    for rel in MANIFESTS:
        path = ROOT / rel
        try:
            loaded[rel] = json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            print(f"error: could not read/parse {rel}: {exc}", file=sys.stderr)
            return 1

    problems = []
    versions = {rel: m.get("version") for rel, m in loaded.items()}
    if len(set(versions.values())) > 1:
        problems.append(f"version mismatch: {versions}")
    descriptions = {rel: m.get("description") for rel, m in loaded.items()}
    if len(set(descriptions.values())) > 1:
        problems.append(f"description mismatch: {descriptions}")

    if problems:
        for p in problems:
            print(f"error: {p}", file=sys.stderr)
        return 1
    print(f"OK: all manifests at version {next(iter(versions.values()))}, descriptions match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
