import json


def test_codex_strict_schema_adds_every_property_to_required(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    strict = dispatch.codex_strict_schema(schema)
    assert set(strict["required"]) == set(strict["properties"].keys())


def test_codex_strict_schema_unions_null_into_newly_required_optional_fields(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    strict = dispatch.codex_strict_schema(schema)
    assert strict["properties"]["previous_issues"]["type"] == ["array", "null"]
    # already-required fields are untouched
    assert strict["properties"]["issues"]["type"] == "array"


def test_codex_strict_schema_recurses_into_array_items(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    strict = dispatch.codex_strict_schema(schema)
    item_schema = strict["properties"]["issues"]["items"]
    assert set(item_schema["required"]) == set(item_schema["properties"].keys())


def test_codex_strict_schema_does_not_mutate_the_canonical_schema(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    original_required = list(schema["required"])
    dispatch.codex_strict_schema(schema)
    assert schema["required"] == original_required
    assert "previous_issues" not in schema["required"]


def test_codex_strict_schema_on_tester_schema_handles_screenshots(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "tester.json").read_text())
    strict = dispatch.codex_strict_schema(schema)
    assert "screenshots" in strict["required"]
    assert strict["properties"]["screenshots"]["type"] == ["array", "null"]


def test_normalize_optional_nulls_drops_null_optional_field(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    result = {"verdict": "approve", "summary": "x", "issues": [], "blocked": [],
              "previous_issues": None}
    normalized = dispatch.normalize_optional_nulls(result, schema)
    assert "previous_issues" not in normalized
    assert dispatch.validate(normalized, schema) is None


def test_normalize_optional_nulls_keeps_required_field_even_if_null(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    result = {"verdict": "approve", "summary": "x", "issues": None, "blocked": []}
    normalized = dispatch.normalize_optional_nulls(result, schema)
    assert normalized["issues"] is None  # still invalid -- required fields aren't dropped
    assert dispatch.validate(normalized, schema) is not None


def test_normalize_optional_nulls_keeps_a_real_optional_value(dispatch):
    schema = json.loads((dispatch.ROOT / "schemas" / "code-reviewer.json").read_text())
    result = {"verdict": "approve", "summary": "x", "issues": [], "blocked": [],
              "previous_issues": [{"id": "R1-1", "status": "resolved", "note": "fixed"}]}
    normalized = dispatch.normalize_optional_nulls(result, schema)
    assert normalized["previous_issues"] == result["previous_issues"]


def test_build_command_codex_writes_strict_schema_to_tmp_and_points_there(dispatch, tmp_path):
    import argparse
    args = argparse.Namespace(role="code-reviewer", cli="codex", model="gpt-5.6-terra",
                               effort="low", timeout=60, skip_permissions=False, cwd=str(tmp_path))
    schema_path = dispatch.ROOT / "schemas" / "code-reviewer.json"
    cmd, stdin, last = dispatch.build_command(args, "prompt text", tmp_path / "p.md",
                                              schema_path, str(tmp_path))
    idx = cmd.index("--output-schema")
    written_schema = json.loads(open(cmd[idx + 1]).read())
    assert set(written_schema["required"]) == set(written_schema["properties"].keys())
    assert cmd[idx + 1] != str(schema_path)  # never points at the canonical file
