#!/usr/bin/env python3
"""Print the crewbench splash banner: a small pixel-art rendition of the
crewbench mark (a rounded cream tile with a red chevron and a black "b")
next to the name, version and a one-line quickstart hint -- in the same
style as Claude Code's own startup banner (icon left, text right).

Every crewbench skill runs this as its first action (see the "Before you
start" line near the top of each SKILL.md), so it prints once per
`/crewbench:*` invocation, not once per session.

Usage:
  python3 <root>/bin/crewbench_banner.py
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CREAM = (245, 243, 238)
RED = (196, 64, 52)
BLACK = (24, 24, 24)

# 7 rows x 11 cols. '.' is transparent (terminal background shows through),
# 'C' the tile, 'R' the chevron, 'B' the "b".
ICON = [
    ".CCCCCCCCC.",
    "CR...CB...C",
    "C.R..CB...C",
    "C..R.CBBB.C",
    "C.R..CB..BC",
    "CR...CBBB.C",
    ".CCCCCCCCC.",
]

COLORS = {"C": CREAM, "R": RED, "B": BLACK}


def version():
    try:
        data = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        return data.get("version", "")
    except Exception:
        return ""


def icon_row(row, color):
    if not color:
        return "".join("  " if c == "." else "##" for c in row)
    out = []
    for c in row:
        if c == ".":
            out.append("\033[0m  ")
        else:
            r, g, b = COLORS[c]
            out.append(f"\033[48;2;{r};{g};{b}m  ")
    out.append("\033[0m")
    return "".join(out)


def main():
    color = os.environ.get("NO_COLOR") is None
    bold = "\033[1m" if color else ""
    dim = "\033[2m" if color else ""
    reset = "\033[0m" if color else ""

    v = version()
    title = f"{bold}CrewBench{reset}" + (f" {dim}v{v}{reset}" if v else "")
    lines = {
        2: title,
        3: f"{dim}Team Lead + Developer, Tester, Code Reviewer, UI/UX Designer{reset}",
        4: f"{dim}/crewbench:new-task to start · /crewbench:doctor to check setup{reset}",
    }

    print()
    for i, row in enumerate(ICON):
        text = lines.get(i, "")
        print(f"  {icon_row(row, color)}  {text}")
    print()


if __name__ == "__main__":
    sys.exit(main())
