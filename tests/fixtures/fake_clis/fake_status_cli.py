#!/usr/bin/env python3
"""Fake CLI used by test_doctor.py to stand in for whichever real CLI's
--version / auth-status / login-status / models subcommand `doctor` calls.
Branches on argv content, not on its own name, so one script covers all four
CLIs' different status commands. Exit non-zero and print FAKE_STATUS_FAIL's
value instead when that env var is set, to test doctor's failure path.
"""
import json
import os
import sys

argv = sys.argv[1:]
fail = os.environ.get("FAKE_STATUS_FAIL")

if "--version" in argv:
    print("fake-cli 9.9.9")
    sys.exit(0)

if fail:
    print(fail, file=sys.stderr)
    sys.exit(1)

if "auth" in argv and "status" in argv:
    print(json.dumps({"loggedIn": True, "email": "fake@example.com"}))
elif "login" in argv and "status" in argv:
    print("Logged in using Fake")
elif "models" in argv:
    print("fake-model-1\tFake Model One")
else:
    print("ok")
sys.exit(0)
