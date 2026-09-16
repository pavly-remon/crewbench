#!/usr/bin/env python3
"""Detect a project's package manager, commands and conventions for
`.crewbench/project.json`. Stdlib only. Never writes anything itself — the
`/crewbench:profile` skill shows this proposal to the user and only saves it
on confirmation (see lib/dispatch.md and schemas/project.json).

Usage:
  python3 <root>/bin/crewbench_profile.py detect [--cwd <dir>]
      -> prints the proposed project.json as JSON

  python3 <root>/bin/crewbench_profile.py agy-rules --commands <json>
      -> prints suggested `command(...)` agy allow rules for the given
         {name: command} map (see agy_command_rules() in crewbench_dispatch.py
         for the matching semantics these rules must satisfy)
"""
import argparse
import json
import re
import sys
from pathlib import Path

LOCKFILE_PACKAGE_MANAGERS = {
    "package-lock.json": "npm",
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "bun.lockb": "bun",
}

INSTALL_COMMANDS = {
    "npm": "npm ci",
    "pnpm": "pnpm install --frozen-lockfile",
    "yarn": "yarn install --frozen-lockfile",
    "bun": "bun install",
}

RUN_PREFIX = {"npm": "npm run", "pnpm": "pnpm", "yarn": "yarn", "bun": "bun run"}


def empty_profile():
    return {
        "package_manager": None,
        "install": None,
        "commands": {"lint": None, "typecheck": None, "test": None,
                    "test_changed": None, "build": None, "format_check": None},
        "test_patterns": [],
        "source_dirs": [],
        "languages": [],
        "frameworks": [],
        "agy_allow_rules": [],
        "confirmed": False,
    }


def _script_command(scripts, run_prefix, names):
    for name in names:
        if name in scripts:
            return f"{run_prefix} {name}"
    return None


def detect_node(root, profile):
    pkg_path = root / "package.json"
    if not pkg_path.exists():
        return
    try:
        pkg = json.loads(pkg_path.read_text())
    except (OSError, ValueError):
        pkg = {}
    scripts = pkg.get("scripts", {}) if isinstance(pkg.get("scripts"), dict) else {}
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}

    profile["languages"].append("typescript" if (root / "tsconfig.json").exists() else "javascript")

    pm = next((v for f, v in LOCKFILE_PACKAGE_MANAGERS.items() if (root / f).exists()), None)
    profile["package_manager"] = pm
    if pm:
        profile["install"] = INSTALL_COMMANDS[pm]
    run = RUN_PREFIX.get(pm, "npm run")

    profile["commands"]["lint"] = _script_command(scripts, run, ["lint"])
    profile["commands"]["typecheck"] = _script_command(scripts, run, ["typecheck", "type-check", "tsc"])
    profile["commands"]["test"] = _script_command(scripts, run, ["test"])
    profile["commands"]["build"] = _script_command(scripts, run, ["build"])
    profile["commands"]["format_check"] = _script_command(scripts, run, ["format:check", "format-check"])

    if "jest" in deps:
        profile["frameworks"].append("jest")
        profile["commands"]["test_changed"] = profile["commands"]["test_changed"] or f"{run} test -- --changed"
        profile["test_patterns"] += ["*.test.js", "*.test.ts", "*.test.jsx", "*.test.tsx"]
    if "vitest" in deps:
        profile["frameworks"].append("vitest")
        profile["commands"]["test_changed"] = profile["commands"]["test_changed"] or f"{run} test -- --changed"
        profile["test_patterns"] += ["*.test.js", "*.test.ts", "*.spec.js", "*.spec.ts"]
    if (root / "playwright.config.ts").exists() or (root / "playwright.config.js").exists():
        profile["frameworks"].append("playwright")
        profile["test_patterns"].append("*.spec.ts")
    if any((root / f).exists() for f in (".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs", "eslint.config.js")):
        profile["frameworks"].append("eslint")
        profile["commands"]["lint"] = profile["commands"]["lint"] or f"{run_prefix_bin(pm)} eslint ."
    if any((root / f).exists() for f in (".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js")):
        profile["frameworks"].append("prettier")
        profile["commands"]["format_check"] = profile["commands"]["format_check"] or f"{run_prefix_bin(pm)} prettier --check ."
    if (root / "biome.json").exists() or (root / "biome.jsonc").exists():
        profile["frameworks"].append("biome")
        profile["commands"]["lint"] = profile["commands"]["lint"] or f"{run_prefix_bin(pm)} biome check ."


def run_prefix_bin(pm):
    return {"npm": "npx", "pnpm": "pnpm exec", "yarn": "yarn", "bun": "bunx"}.get(pm, "npx")


def detect_python(root, profile):
    has_pyproject = (root / "pyproject.toml").exists()
    has_requirements = any(root.glob("requirements*.txt"))
    if not (has_pyproject or has_requirements):
        return
    profile["languages"].append("python")
    profile["package_manager"] = profile["package_manager"] or "pip"
    if has_pyproject:
        text = (root / "pyproject.toml").read_text(errors="replace")
        if "poetry" in text:
            profile["package_manager"] = "poetry"
            profile["install"] = profile["install"] or "poetry install"
        elif re.search(r"\[tool\.(uv|pdm)\]", text) or "uv" in text.lower():
            profile["package_manager"] = "uv" if "[tool.uv]" in text else profile["package_manager"]
    profile["install"] = profile["install"] or ("pip install -e .[dev]" if has_pyproject else "pip install -r requirements.txt")
    has_pytest_ini = any((root / d).exists() for d in ("pytest.ini", "conftest.py"))
    has_pytest_config = has_pyproject and "pytest" in (root / "pyproject.toml").read_text(errors="replace")
    if has_pytest_ini or has_pytest_config:
        profile["frameworks"].append("pytest")
        profile["commands"]["test"] = profile["commands"]["test"] or "pytest"
        profile["commands"]["test_changed"] = profile["commands"]["test_changed"] or "pytest --picked"
        profile["test_patterns"] += ["test_*.py", "*_test.py"]
    if (root / "ruff.toml").exists() or (root / ".ruff.toml").exists() or (has_pyproject and "ruff" in (root / "pyproject.toml").read_text(errors="replace")):
        profile["frameworks"].append("ruff")
        profile["commands"]["lint"] = profile["commands"]["lint"] or "ruff check ."
        profile["commands"]["format_check"] = profile["commands"]["format_check"] or "ruff format --check ."
    if (root / "mypy.ini").exists() or (has_pyproject and "mypy" in (root / "pyproject.toml").read_text(errors="replace")):
        profile["frameworks"].append("mypy")
        profile["commands"]["typecheck"] = profile["commands"]["typecheck"] or "mypy ."


def detect_go(root, profile):
    if not (root / "go.mod").exists():
        return
    profile["languages"].append("go")
    profile["package_manager"] = "go"
    profile["commands"]["test"] = profile["commands"]["test"] or "go test ./..."
    profile["commands"]["build"] = profile["commands"]["build"] or "go build ./..."
    profile["commands"]["lint"] = profile["commands"]["lint"] or ("golangci-lint run" if (root / ".golangci.yml").exists() else profile["commands"]["lint"])
    profile["test_patterns"].append("*_test.go")


def detect_make(root, profile):
    makefile = root / "Makefile"
    if not makefile.exists():
        return
    try:
        targets = set(re.findall(r"^([a-zA-Z][\w-]*):", makefile.read_text(errors="replace"), re.M))
    except OSError:
        return
    for field, names in (("lint", ["lint"]), ("typecheck", ["typecheck", "type-check"]),
                        ("test", ["test"]), ("build", ["build"]), ("format_check", ["fmt-check", "format-check"])):
        if profile["commands"][field] is None:
            match = next((n for n in names if n in targets), None)
            if match:
                profile["commands"][field] = f"make {match}"


def detect_source_dirs(root, profile):
    for candidate in ("src", "lib", "app", "cmd", "internal", "pkg"):
        if (root / candidate).is_dir():
            profile["source_dirs"].append(candidate)


def detect(root):
    profile = empty_profile()
    detect_node(root, profile)
    detect_python(root, profile)
    detect_go(root, profile)
    detect_make(root, profile)
    detect_source_dirs(root, profile)
    profile["languages"] = sorted(set(profile["languages"]))
    profile["frameworks"] = sorted(set(profile["frameworks"]))
    profile["test_patterns"] = sorted(set(profile["test_patterns"]))
    return profile


def agy_rules_for_commands(commands):
    """Suggested agy `command(...)` allow rules for a {name: command} map,
    using agy's real matching semantics (word-by-word prefix, see
    agy_command_rules() in crewbench_dispatch.py): each rule is the
    command's first two words (binary + subcommand) with no trailing `*`,
    since agy already treats a rule as a prefix."""
    rules = []
    for command in commands.values():
        if not command:
            continue
        words = command.split()
        prefix = " ".join(words[:2]) if len(words) > 1 else words[0]
        rule = f"command({prefix})"
        if rule not in rules:
            rules.append(rule)
    return rules


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    detect_p = sub.add_parser("detect")
    detect_p.add_argument("--cwd", default=".")
    rules_p = sub.add_parser("agy-rules")
    rules_p.add_argument("--commands", required=True, help="JSON {name: command}")
    args = p.parse_args()

    if args.cmd == "detect":
        profile = detect(Path(args.cwd).resolve())
        profile["agy_allow_rules"] = agy_rules_for_commands(profile["commands"])
        print(json.dumps(profile, indent=2))
    elif args.cmd == "agy-rules":
        commands = json.loads(args.commands)
        print(json.dumps(agy_rules_for_commands(commands), indent=2))


if __name__ == "__main__":
    main()
