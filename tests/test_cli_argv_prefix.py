def test_real_executable_passes_through_unchanged(dispatch):
    assert dispatch.cli_argv_prefix("/usr/local/bin/claude") == ["/usr/local/bin/claude"]


def test_py_override_passes_through_unchanged_on_posix(dispatch, monkeypatch):
    monkeypatch.setattr(dispatch.os, "name", "posix")
    assert dispatch.cli_argv_prefix("/repo/tests/fixtures/fake_clis/quick_success.py") == \
        ["/repo/tests/fixtures/fake_clis/quick_success.py"]


def test_py_override_gets_interpreter_prefix_on_windows(dispatch, monkeypatch):
    # Regression: found running this repo's own test suite for real on
    # Windows CI -- CREWBENCH_CLI_OVERRIDE_<CLI> pointing at a bare .py
    # path failed with an empty envelope, because subprocess.Popen can't
    # launch a .py file directly on Windows without shell=True.
    monkeypatch.setattr(dispatch.os, "name", "nt")
    result = dispatch.cli_argv_prefix("C:\\repo\\tests\\fixtures\\fake_clis\\quick_success.py")
    assert result == [dispatch.sys.executable, "C:\\repo\\tests\\fixtures\\fake_clis\\quick_success.py"]


def test_real_windows_exe_is_unaffected(dispatch, monkeypatch):
    monkeypatch.setattr(dispatch.os, "name", "nt")
    assert dispatch.cli_argv_prefix("C:\\Program Files\\claude\\claude.exe") == \
        ["C:\\Program Files\\claude\\claude.exe"]
