import { describe, expect, it } from "vitest";
import { classifySandboxError } from "../src/sandbox.js";

// Ported from tests/test_sandbox_signatures.py.
describe("classifySandboxError", () => {
  const cases: [string, string | null][] = [
    ["Error: getaddrinfo ENOTFOUND api.anthropic.com", "blocks network"],
    ["connect ECONNREFUSED 127.0.0.1:443", "blocks network"],
    ["EACCES: permission denied, open '/Users/x/.codex/auth.json'", "config/auth directory"],
    ["Please run: claude auth login", "doesn't appear to be logged in"],
    ["401 Unauthorized", "doesn't appear to be logged in"],
    ["some unrelated tool error", null],
  ];

  for (const [text, expectedSubstr] of cases) {
    it(`classifies: ${text}`, () => {
      const hint = classifySandboxError(text);
      if (expectedSubstr === null) {
        expect(hint).toBeNull();
      } else {
        expect(hint).not.toBeNull();
        expect(hint).toContain(expectedSubstr);
      }
    });
  }
});
