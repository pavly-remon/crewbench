import json


def test_defaults_json_has_loop_settings(dispatch):
    defaults = json.loads((dispatch.ROOT / "config" / "defaults.json").read_text())
    assert defaults["loop"]["max_rounds"] == 3
    assert defaults["loop"]["fix_threshold"] == "major"


def test_code_reviewer_schema_requires_issue_id_and_allows_previous_issues(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    issue_schema = schema["properties"]["issues"]["items"]
    assert "id" in issue_schema["required"]
    assert "previous_issues" in schema["properties"]
    assert "previous_issues" not in schema["required"]  # optional, only from round 2 on

    result = {
        "verdict": "changes_requested", "summary": "x", "blocked": [],
        "issues": [{"id": "R2-1", "file": "a.py", "line": 1, "severity": "minor",
                    "category": "consistency", "change": "y"}],
        "previous_issues": [{"id": "R1-3", "status": "resolved", "note": "fixed in this round"}],
    }
    assert dispatch.validate(result, schema) is None


def test_code_reviewer_schema_rejects_bad_previous_issue_status(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    result = {
        "verdict": "approve", "summary": "x", "issues": [], "blocked": [],
        "previous_issues": [{"id": "R1-1", "status": "not-a-status", "note": "x"}],
    }
    err = dispatch.validate(result, schema)
    assert err is not None and "status" in err
