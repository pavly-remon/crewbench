import { describe, expect, it } from "vitest";
import { shellSplit } from "../src/shell-split.js";

// Ported from tests/test_gate.py's _split() coverage.
describe("shellSplit", () => {
  it("strips quotes around a token", () => {
    expect(shellSplit('python -c "import sys; sys.exit(1)"')).toEqual(["python", "-c", "import sys; sys.exit(1)"]);
  });

  it("preserves backslashes in an unquoted Windows path", () => {
    const tokens = shellSplit(String.raw`C:\hostedtoolcache\windows\Python\3.12.10\x64\python.exe -c 1`);
    expect(tokens[0]).toBe(String.raw`C:\hostedtoolcache\windows\Python\3.12.10\x64\python.exe`);
  });

  it("handles a plain unquoted command", () => {
    expect(shellSplit("pytest -q --maxfail=1")).toEqual(["pytest", "-q", "--maxfail=1"]);
  });

  it("handles single-quoted tokens", () => {
    expect(shellSplit("node -e 'console.log(1)'")).toEqual(["node", "-e", "console.log(1)"]);
  });
});
