import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]
# Phase 4 milestone 5: bump_version.py now also bumps the published app
# package's own version (Design decision 8) -- this fixture needs the
# real file present at the same relative path the real repo has it, or
# the script's own ROOT-relative read of it fails outright (a real
# regression this milestone's own test run caught live: the fixture
# only copied the three plugin manifests, not app/packages/cli/package.json,
# so bump_version.py crashed with a real FileNotFoundError the moment it
# tried to read a manifest this test fixture never created).
ALL_MANIFESTS = MANIFESTS + ["app/packages/cli/package.json"]


def _copy_repo_manifests(tmp_path):
    for rel in ALL_MANIFESTS:
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
    for rel in ALL_MANIFESTS:
        data = json.loads((tmp_path / rel).read_text())
        assert data["version"] == "9.9.9"


def test_bumps_the_published_app_package_too(tmp_path):
    # Phase 4 milestone 5: app/packages/{contract,adapters,engine,daemon}/
    # package.json deliberately NOT bumped -- they stay "private": true
    # and are never independently published (Design decision 1's
    # bundle-not-multi-publish call, confirmed by reading
    # app/packages/cli/scripts/build-publish.mjs directly), so only the
    # one package that's actually published gets a version bump here.
    _copy_repo_manifests(tmp_path)
    _run(tmp_path, "9.9.9")
    data = json.loads((tmp_path / "app/packages/cli/package.json").read_text())
    assert data["version"] == "9.9.9"
    assert data["name"] == "crewbench"


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
