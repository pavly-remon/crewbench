import json
import os
import socket
import subprocess
import sys
import threading


def _listener():
    """A local TCP server that just accepts and closes — stands in for a
    reachable API host without depending on live internet access."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    def serve():
        try:
            conn, _ = srv.accept()
            conn.close()
        except OSError:
            pass

    threading.Thread(target=serve, daemon=True).start()
    return srv, port


def _run_doctor(dispatch, cli, env_extra, cwd):
    env = dict(os.environ)
    env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, str(dispatch.ROOT / "bin" / "crewbench_dispatch.py"),
         "doctor", "--cli", cli],
        cwd=cwd, env=env, capture_output=True, text=True, timeout=30,
    )
    return proc, json.loads(proc.stdout)


def test_doctor_reports_ok_when_everything_checks_out(dispatch, tmp_path, fake_cli_dir):
    srv, port = _listener()
    try:
        env = {
            "CREWBENCH_CLI_OVERRIDE_CLAUDE": str(fake_cli_dir / "fake_status_cli.py"),
            "CREWBENCH_NETWORK_CHECK_OVERRIDE_CLAUDE": f"127.0.0.1:{port}",
        }
        proc, report = _run_doctor(dispatch, "claude", env, tmp_path)
        assert proc.returncode == 0
        assert report["ok"] is True
        assert report["installed"] is True
        assert report["network_ok"] is True
        assert report["logged_in"] is True
        assert report["errors"] == []
    finally:
        srv.close()


def test_doctor_reports_not_installed(dispatch, tmp_path):
    env = {"CREWBENCH_CLI_OVERRIDE_CODEX": ""}  # falls through to PATH lookup
    env["PATH"] = "/nonexistent"
    proc, report = _run_doctor(dispatch, "codex", env, tmp_path)
    assert proc.returncode == 1
    assert report["ok"] is False
    assert report["installed"] is False
    assert "not installed" in report["errors"][0]


def test_doctor_flags_unreachable_network(dispatch, tmp_path, fake_cli_dir):
    env = {
        "CREWBENCH_CLI_OVERRIDE_AGY": str(fake_cli_dir / "fake_status_cli.py"),
        # nothing listening on this port
        "CREWBENCH_NETWORK_CHECK_OVERRIDE_AGY": "127.0.0.1:1",
    }
    proc, report = _run_doctor(dispatch, "agy", env, tmp_path)
    assert proc.returncode == 1
    assert report["ok"] is False
    assert report["network_ok"] is False
    assert any("sandbox blocks network" in e for e in report["errors"])


def test_doctor_flags_not_logged_in(dispatch, tmp_path, fake_cli_dir):
    srv, port = _listener()
    try:
        env = {
            "CREWBENCH_CLI_OVERRIDE_CODEX": str(fake_cli_dir / "fake_status_cli.py"),
            "CREWBENCH_NETWORK_CHECK_OVERRIDE_CODEX": f"127.0.0.1:{port}",
            "FAKE_STATUS_FAIL": "not logged in",
        }
        proc, report = _run_doctor(dispatch, "codex", env, tmp_path)
        assert proc.returncode == 1
        assert report["ok"] is False
        assert report["logged_in"] is False
        assert any("does not appear to be logged in" in e for e in report["errors"])
    finally:
        srv.close()
