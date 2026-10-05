import importlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
crewbench_profile = importlib.import_module("crewbench_profile")


def run_profile(*args):
    result = subprocess.run(
        [sys.executable, str(Path(crewbench_profile.__file__)), *args],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_detect_node_npm_jest_eslint(tmp_path):
    (tmp_path / "package-lock.json").write_text("{}")
    (tmp_path / "package.json").write_text(json.dumps({
        "scripts": {"lint": "eslint .", "test": "jest", "build": "tsc -b"},
        "devDependencies": {"jest": "^29", "eslint": "^9"},
    }))
    (tmp_path / ".eslintrc.json").write_text("{}")
    profile = run_profile("detect", "--cwd", str(tmp_path))
    assert profile["package_manager"] == "npm"
    assert profile["install"] == "npm ci"
    assert profile["commands"]["lint"] == "npm run lint"
    assert profile["commands"]["test"] == "npm run test"
    assert "jest" in profile["frameworks"]
    assert "eslint" in profile["frameworks"]
    assert profile["confirmed"] is False


def test_detect_python_requirements_only_no_pytest_ini(tmp_path):
    # Regression: detect_python() used to crash reading a nonexistent
    # pyproject.toml when only requirements*.txt was present (operator
    # precedence bug in an `A or B if C else D` expression).
    (tmp_path / "requirements.txt").write_text("flask\n")
    profile = run_profile("detect", "--cwd", str(tmp_path))
    assert profile["package_manager"] == "pip"
    assert profile["install"] == "pip install -r requirements.txt"
    assert "pytest" not in profile["frameworks"]


def test_detect_python_pytest_ini_without_pyproject(tmp_path):
    (tmp_path / "requirements.txt").write_text("pytest\n")
    (tmp_path / "pytest.ini").write_text("[pytest]\n")
    profile = run_profile("detect", "--cwd", str(tmp_path))
    assert "pytest" in profile["frameworks"]
    assert profile["commands"]["test"] == "pytest"


def test_detect_go(tmp_path):
    (tmp_path / "go.mod").write_text("module example.com/x\n\ngo 1.22\n")
    profile = run_profile("detect", "--cwd", str(tmp_path))
    assert profile["languages"] == ["go"]
    assert profile["commands"]["test"] == "go test ./..."


def test_detect_empty_dir_is_a_valid_confirmed_shape(tmp_path):
    profile = run_profile("detect", "--cwd", str(tmp_path))
    assert profile["languages"] == []
    assert profile["package_manager"] is None
    assert profile["commands"] == {
        "lint": None, "typecheck": None, "test": None,
        "test_changed": None, "build": None, "format_check": None,
    }


def test_agy_rules_for_commands_uses_binary_and_subcommand_prefix():
    rules = crewbench_profile.agy_rules_for_commands({
        "lint": "npm run lint", "test": "pytest -q", "solo": "go"
    })
    assert rules == ["command(npm run)", "command(pytest -q)", "command(go)"]


def test_agy_rules_skips_null_commands_and_dedupes():
    rules = crewbench_profile.agy_rules_for_commands({
        "lint": "npm run lint", "format_check": None, "test": "npm run lint"
    })
    assert rules == ["command(npm run)"]
