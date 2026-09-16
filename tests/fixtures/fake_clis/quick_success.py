#!/usr/bin/env python3
"""Fake CLI used by tests for the detached start/wait/cancel protocol and the
recursion guard: ignores its argv, optionally sleeps (FAKE_CLI_SLEEP, default
0) so a test can catch it mid-run, then prints the same claude-shaped
stream-json fixture as tests/fixtures/claude_stream.jsonl so parse_output()
succeeds with a valid envelope.
"""
import os
import time

sleep_s = float(os.environ.get("FAKE_CLI_SLEEP", "0"))
if sleep_s:
    time.sleep(sleep_s)

for line in (
    '{"type": "system", "subtype": "init", "session_id": "quick-0001", "model": "m"}',
    '{"type": "result", "subtype": "success", "is_error": false, "status": "SUCCESS", '
    '"structured_output": {"status": "done", "summary": "ok", "files_changed": [], '
    '"assumptions": [], "questions": [], "blocked": []}, "permission_denials": []}',
):
    print(line)
