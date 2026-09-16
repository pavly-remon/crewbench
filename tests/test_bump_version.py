import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]


def _copy_repo_manifests(tmp_path):
    for rel in MANIFESTS:
        dest = tmp_path / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, dest)
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir(exist_ok=True)
    shutil.copy(ROOT / "scripts" / "bump_version.py", scripts_dir / "bump_version.py")
    shutil.copy(ROOT / "scripts" / "check_manifests.py", scripts_dir / "check_manifests.py")


def _run(tmp_path, *args):
    return subprocess.run(
        [sys.executable, str(tmp_path / "scripts" / "bump_version.py"), *args],
        cwd=tmp_path, capture_output=True, text=True,
    )


def test_bumps_all_three_manifests(tmp_path):
    _copy_repo_manifests(tmp_path)
    result = _run(tmp_path, "9.9.9")
    assert result.returncode == 0, result.stderr
    for rel in MANIFESTS:
        data = json.loads((tmp_path / rel).read_text())
        assert data["version"] == "9.9.9"


def test_preserves_other_fields_and_key_order(tmp_path):
    _copy_repo_manifests(tmp_path)
    before = json.loads((tmp_path / ".codex-plugin" / "plugin.json").read_text())
    _run(tmp_path, "9.9.9")
    after = json.loads((tmp_path / ".codex-plugin" / "plugin.json").read_text())
    assert list(before.keys()) == list(after.keys())
    assert after["keywords"] == before["keywords"]
    assert after["skills"] == before["skills"]


def test_rejects_malformed_version(tmp_path):
    _copy_repo_manifests(tmp_path)
    result = _run(tmp_path, "not-a-version")
    assert result.returncode == 1
    original = (tmp_path / "plugin.json").read_text()
    assert json.loads(original)["version"] != "not-a-version"


def test_no_args_prints_usage(tmp_path):
    _copy_repo_manifests(tmp_path)
    result = _run(tmp_path)
    assert result.returncode == 1
    assert "usage" in result.stderr.lower()
