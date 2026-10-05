import json


def _write_settings(home, rules):
    settings_dir = home / ".gemini" / "antigravity-cli"
    settings_dir.mkdir(parents=True)
    (settings_dir / "settings.json").write_text(json.dumps({"permissions": {"allow": rules}}))


def test_usable_and_broken_rules_are_split(dispatch, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatch.Path, "home", classmethod(lambda cls: tmp_path))
    _write_settings(tmp_path, [
        "command(npm test)",
        "command(ls)",
        "command(ls*)",              # broken: agy never matches a trailing *
        "command(*)",                # the one wildcard form that does work
        "command(regex:npm run (build|lint))",
        "not-a-command-rule",        # ignored, not command(...)
    ])
    usable, broken = dispatch.agy_command_rules()
    assert "npm test" in usable
    assert "ls" in usable
    assert "*" in usable
    assert "regex:npm run (build|lint)" in usable
    assert "command(ls*)" in broken
    assert "ls*" not in usable


def test_no_settings_file_returns_empty(dispatch, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatch.Path, "home", classmethod(lambda cls: tmp_path))
    usable, broken = dispatch.agy_command_rules()
    assert usable == [] and broken == []


def test_malformed_settings_json_returns_empty(dispatch, tmp_path, monkeypatch):
    monkeypatch.setattr(dispatch.Path, "home", classmethod(lambda cls: tmp_path))
    settings_dir = tmp_path / ".gemini" / "antigravity-cli"
    settings_dir.mkdir(parents=True)
    (settings_dir / "settings.json").write_text("{not json")
    usable, broken = dispatch.agy_command_rules()
    assert usable == [] and broken == []
