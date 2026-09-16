def test_existing_writable_dir_is_writable(dispatch, tmp_path):
    assert dispatch._dir_writable(str(tmp_path)) is True


def test_nonexistent_dir_with_writable_parent_is_writable(dispatch, tmp_path):
    # Regression: a fresh machine/CI runner that has never logged into a
    # given CLI has no ~/.claude yet, but the home dir (its parent) is
    # writable, so the config dir could still be created on first login.
    missing = tmp_path / "not-created-yet"
    assert dispatch._dir_writable(str(missing)) is True


def test_deeply_nested_nonexistent_dir_still_resolves_to_writable_ancestor(dispatch, tmp_path):
    missing = tmp_path / "a" / "b" / "c"
    assert dispatch._dir_writable(str(missing)) is True


def test_nonexistent_dir_under_a_read_only_ancestor_is_not_writable(dispatch, tmp_path):
    import os

    import pytest
    if os.name == "nt":
        pytest.skip("chmod doesn't restrict directory writability on Windows "
                     "(confirmed live on Windows CI: os.access still reports W_OK)")
    ro_parent = tmp_path / "read-only-parent"
    ro_parent.mkdir()
    os.chmod(ro_parent, 0o500)
    try:
        assert dispatch._dir_writable(str(ro_parent / "not-created-yet")) is False
    finally:
        os.chmod(ro_parent, 0o700)  # restore so tmp_path cleanup can remove it


def test_a_file_instead_of_a_directory_is_not_writable(dispatch, tmp_path):
    f = tmp_path / "a_file"
    f.write_text("x")
    assert dispatch._dir_writable(str(f)) is False
