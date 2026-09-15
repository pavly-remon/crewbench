import subprocess


def run_git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_commit_moves_head_and_warns(dispatch, git_repo):
    before = dispatch.git_state(git_repo)
    (git_repo / "b.txt").write_text("new\n")
    run_git(git_repo, "add", "b.txt")
    run_git(git_repo, "commit", "-q", "-m", "second")
    after = dispatch.git_state(git_repo)
    warnings, notes = dispatch.git_changes("developer", before, after)
    assert any("moved HEAD" in w for w in warnings)
    assert notes == []


def test_stash_is_flagged(dispatch, git_repo):
    (git_repo / "a.txt").write_text("dirty\n")
    before = dispatch.git_state(git_repo)
    run_git(git_repo, "stash")
    after = dispatch.git_state(git_repo)
    warnings, _ = dispatch.git_changes("developer", before, after)
    assert any("stash" in w for w in warnings)


def test_checkout_dash_dash_reverts_dirty_file_and_warns(dispatch, git_repo):
    (git_repo / "a.txt").write_text("developer's uncommitted work\n")
    before = dispatch.git_state(git_repo)
    run_git(git_repo, "checkout", "--", "a.txt")
    after = dispatch.git_state(git_repo)
    warnings, _ = dispatch.git_changes("developer", before, after)
    assert any("reverted or deleted uncommitted changes in: a.txt" in w for w in warnings)


def test_reset_hard_reverts_dirty_file_and_warns(dispatch, git_repo):
    (git_repo / "a.txt").write_text("developer's uncommitted work\n")
    before = dispatch.git_state(git_repo)
    run_git(git_repo, "reset", "--hard", "HEAD")
    after = dispatch.git_state(git_repo)
    warnings, _ = dispatch.git_changes("developer", before, after)
    assert any("reverted or deleted uncommitted changes in: a.txt" in w for w in warnings)


def test_fetch_only_is_a_note_not_a_warning(dispatch, git_repo, tmp_path):
    # git_repo tracks a bare "origin"; someone else pushes a commit to it that
    # git_repo hasn't seen yet, so fetching moves the remote-tracking ref
    # without moving git_repo's own HEAD.
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    run_git(git_repo, "remote", "add", "origin", str(remote))
    run_git(git_repo, "push", "-q", "-u", "origin", "HEAD:main")

    other = tmp_path / "other-clone"
    subprocess.run(["git", "clone", "-q", str(remote), str(other)], check=True)
    run_git(other, "checkout", "-B", "main", "origin/main")
    (other / "elsewhere.txt").write_text("from someone else\n")
    run_git(other, "add", "elsewhere.txt")
    run_git(other, "-c", "user.email=x@x.com", "-c", "user.name=x", "commit", "-q", "-m", "elsewhere")
    run_git(other, "push", "-q", "origin", "HEAD:main")

    before = dispatch.git_state(git_repo)
    run_git(git_repo, "fetch", "origin")
    after = dispatch.git_state(git_repo)
    warnings, notes = dispatch.git_changes("developer", before, after)
    assert not any("push" in w.lower() for w in warnings)
    assert any("fetch" in n for n in notes)


def test_push_is_detected_and_warned(dispatch, git_repo, tmp_path):
    remote = tmp_path / "remote2.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    run_git(git_repo, "remote", "add", "origin", str(remote))
    run_git(git_repo, "push", "-q", "-u", "origin", "HEAD:main")

    before = dispatch.git_state(git_repo)
    (git_repo / "d.txt").write_text("x\n")
    run_git(git_repo, "add", "d.txt")
    run_git(git_repo, "commit", "-q", "-m", "d")
    run_git(git_repo, "push", "-q", "origin", "HEAD:main")
    after = dispatch.git_state(git_repo)
    warnings, notes = dispatch.git_changes("developer", before, after)
    assert any("pushed" in w for w in warnings)


def test_code_reviewer_any_change_warns(dispatch, git_repo):
    before = dispatch.git_state(git_repo)
    (git_repo / "a.txt").write_text("reviewer touched this\n")
    after = dispatch.git_state(git_repo)
    warnings, _ = dispatch.git_changes("code-reviewer", before, after)
    assert any("read-only" in w for w in warnings)


def test_tester_non_test_file_warns(dispatch, git_repo):
    before = dispatch.git_state(git_repo)
    (git_repo / "app.py").write_text("x = 1\n")
    after = dispatch.git_state(git_repo)
    warnings, _ = dispatch.git_changes("tester", before, after)
    assert any("non-test files" in w and "app.py" in w for w in warnings)


def test_tester_test_file_does_not_warn(dispatch, git_repo):
    before = dispatch.git_state(git_repo)
    (git_repo / "app.test.js").write_text("test('x', () => {})\n")
    after = dispatch.git_state(git_repo)
    warnings, _ = dispatch.git_changes("tester", before, after)
    assert not any("non-test files" in w for w in warnings)


def test_no_changes_no_warnings(dispatch, git_repo):
    before = dispatch.git_state(git_repo)
    after = dispatch.git_state(git_repo)
    warnings, notes = dispatch.git_changes("developer", before, after)
    assert warnings == [] and notes == []


def test_outside_git_repo_returns_none(dispatch, tmp_path):
    assert dispatch.git_state(tmp_path) is None
    assert dispatch.git_changes("developer", None, None) == ([], [])
