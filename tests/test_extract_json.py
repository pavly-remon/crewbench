def test_extract_json_plain_object(dispatch):
    assert dispatch.extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_fenced_block(dispatch):
    text = 'Here is my answer:\n```json\n{"a": 1, "b": [1,2]}\n```\nDone.'
    assert dispatch.extract_json(text) == {"a": 1, "b": [1, 2]}


def test_extract_json_last_fenced_block_wins(dispatch):
    text = '```json\n{"a": 1}\n```\nActually:\n```json\n{"a": 2}\n```'
    assert dispatch.extract_json(text) == {"a": 2}


def test_extract_json_embedded_in_prose(dispatch):
    text = 'I did the thing. {"status": "done", "files_changed": []} That is all.'
    assert dispatch.extract_json(text) == {"status": "done", "files_changed": []}


def test_extract_json_last_top_level_object_wins(dispatch):
    text = '{"a": 1} some text {"a": 2}'
    assert dispatch.extract_json(text) == {"a": 2}


def test_extract_json_no_json_returns_none(dispatch):
    assert dispatch.extract_json("no json here") is None


def test_extract_json_empty_returns_none(dispatch):
    assert dispatch.extract_json("") is None
    assert dispatch.extract_json(None) is None


def test_extract_json_ignores_non_object_top_level(dispatch):
    assert dispatch.extract_json("[1, 2, 3]") is None
