import json
import subprocess
import sys

import pytest

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bin"))

import crewbench_env as e  # noqa: E402


def test_detect_host_prefers_override(monkeypatch):
    monkeypatch.setenv("CREWBENCH_HOST_OVERRIDE", "codex")
    assert e.detect_host(chain=[]) == "codex"


def test_detect_host_claudecode_marker(monkeypatch):
    monkeypatch.delenv("CREWBENCH_HOST_OVERRIDE", raising=False)
    monkeypatch.setenv("CLAUDECODE", "1")
    assert e.detect_host(chain=[]) == "claude"


@pytest.mark.parametrize("chain,expected", [
    (["zsh", "agy", "login"], "agy"),
    (["bash", "codex"], "codex"),
    (["node", "copilot", "tmux"], "copilot"),
    (["zsh", "sshd"], "unknown"),
])
def test_detect_host_falls_back_to_parent_chain(monkeypatch, chain, expected):
    monkeypatch.delenv("CREWBENCH_HOST_OVERRIDE", raising=False)
    monkeypatch.delenv("CLAUDECODE", raising=False)
    assert e.detect_host(chain=chain) == expected


def test_resolve_plugin_root_prefers_explicit_override(tmp_path, monkeypatch):
    monkeypatch.setenv("CREWBENCH_PLUGIN_ROOT", str(tmp_path))
    assert e.resolve_plugin_root() == str(tmp_path)


def test_resolve_plugin_root_falls_back_to_own_install_location(monkeypatch):
    monkeypatch.delenv("CREWBENCH_PLUGIN_ROOT", raising=False)
    monkeypatch.delenv("CLAUDE_PLUGIN_ROOT", raising=False)
    assert e.resolve_plugin_root() == str(e.ROOT)


def test_whoami_cli_prints_valid_json():
    proc = subprocess.run([sys.executable, str(ROOT / "bin" / "crewbench_env.py"), "whoami"],
                          capture_output=True, text=True, timeout=10)
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    assert set(["host", "plugin_root", "python", "platform", "config_dir"]) <= set(data)
