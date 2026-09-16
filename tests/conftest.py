import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bin"))

import crewbench_dispatch as d  # noqa: E402


@pytest.fixture
def dispatch():
    return d


@pytest.fixture
def git_repo(tmp_path):
    """A small git repo with one committed file, ready for dirty-tree tests."""
    def run(*args):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    run("init", "-q")
    run("config", "user.email", "test@example.com")
    run("config", "user.name", "Test")
    (tmp_path / "a.txt").write_text("hello\n")
    run("add", "a.txt")
    run("commit", "-q", "-m", "init")
    return tmp_path


@pytest.fixture
def fake_cli_dir():
    return Path(__file__).parent / "fixtures" / "fake_clis"
