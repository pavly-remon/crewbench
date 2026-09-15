import json

import pytest

SCHEMA_NAMES = ["developer", "tester", "code-reviewer", "ui-ux"]


@pytest.mark.parametrize("name", SCHEMA_NAMES)
def test_real_schemas_load_and_are_internally_consistent(dispatch, name):
    schema = json.loads((dispatch.ROOT / "schemas" / f"{name}.json").read_text())
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False


def test_validate_accepts_a_well_formed_developer_result(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "developer.json").read_text())
    result = {"status": "done", "summary": "did it", "files_changed": ["a.py"],
              "assumptions": [], "questions": [], "blocked": []}
    assert dispatch.validate(result, schema) is None


def test_validate_rejects_missing_required_field(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "developer.json").read_text())
    result = {"status": "done", "summary": "did it", "files_changed": [],
              "assumptions": [], "questions": []}  # missing "blocked"
    err = dispatch.validate(result, schema)
    assert err is not None and "blocked" in err


def test_validate_rejects_bad_top_level_enum(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "developer.json").read_text())
    result = {"status": "not-a-status", "summary": "x", "files_changed": [],
              "assumptions": [], "questions": [], "blocked": []}
    err = dispatch.validate(result, schema)
    assert err is not None and "status" in err and "not-a-status" in err


def test_validate_gives_precise_nested_array_path(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    result = {
        "verdict": "changes_requested", "summary": "x", "blocked": [],
        "issues": [
            {"file": "a.py", "line": 1, "severity": "major", "category": "correctness", "change": "fix it"},
            {"file": "b.py", "line": 2, "severity": "critical", "category": "correctness", "change": "fix it"},
        ],
    }
    err = dispatch.validate(result, schema)
    assert err == "issues[1].severity must be one of ['blocker', 'major', 'minor'], got 'critical'"


def test_validate_rejects_additional_properties(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "developer.json").read_text())
    result = {"status": "done", "summary": "x", "files_changed": [], "assumptions": [],
              "questions": [], "blocked": [], "extra_field": 1}
    err = dispatch.validate(result, schema)
    assert err is not None and "extra_field" in err


def test_validate_rejects_wrong_item_type(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "developer.json").read_text())
    result = {"status": "done", "summary": "x", "files_changed": [1, 2],  # should be strings
              "assumptions": [], "questions": [], "blocked": []}
    err = dispatch.validate(result, schema)
    assert err is not None and "files_changed[0]" in err


def test_validate_nullable_line_field(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    result = {
        "verdict": "changes_requested", "summary": "x", "blocked": [],
        "issues": [{"file": "a.py", "line": None, "severity": "minor",
                    "category": "consistency", "change": "y"}],
    }
    assert dispatch.validate(result, schema) is None


def test_validate_non_dict_result(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "developer.json").read_text())
    assert dispatch.validate(["not", "a", "dict"], schema) == "result is not a JSON object"


def test_validate_boolean_is_not_integer(dispatch):
    schema = {"type": "object", "properties": {"n": {"type": "integer"}},
              "required": ["n"], "additionalProperties": False}
    err = dispatch.validate({"n": True}, schema)
    assert err is not None and "n must be of type integer" in err
