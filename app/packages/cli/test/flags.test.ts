import { describe, expect, it } from "vitest";
import { extractJiraKey, parseRunFlags } from "../src/flags.js";

describe("parseRunFlags", () => {
  it("parses a plain task with no flags", () => {
    const flags = parseRunFlags(["Fix", "the", "login", "bug"]);
    expect(flags.taskText).toBe("Fix the login bug");
    expect(flags.yes).toBe(false);
    expect(flags.design).toBe(false);
    expect(flags.inPlace).toBe(false);
    expect(flags.rounds).toBeNull();
    expect(flags.dev).toBeNull();
    expect(flags.review).toBeNull();
  });

  it("strips --yes, --design, --in-place regardless of position", () => {
    const flags = parseRunFlags(["--yes", "Fix", "--design", "the", "bug", "--in-place"]);
    expect(flags.taskText).toBe("Fix the bug");
    expect(flags.yes).toBe(true);
    expect(flags.design).toBe(true);
    expect(flags.inPlace).toBe(true);
  });

  it("parses --rounds N", () => {
    const flags = parseRunFlags(["Fix", "it", "--rounds", "5"]);
    expect(flags.rounds).toBe(5);
    expect(flags.taskText).toBe("Fix it");
  });

  it("throws for a non-numeric --rounds value", () => {
    expect(() => parseRunFlags(["--rounds", "abc"])).toThrow();
  });

  it("rejects a negative --rounds value -- real bug caught by review, Number.parseInt('-1') is a real number, not NaN", () => {
    expect(() => parseRunFlags(["--rounds", "-1"])).toThrow(/positive integer/);
  });

  it("rejects zero -- 'positive' means positive, not non-negative", () => {
    expect(() => parseRunFlags(["--rounds", "0"])).toThrow(/positive integer/);
  });

  it("rejects a partially-numeric value instead of silently truncating it -- real bug caught by review, Number.parseInt('2abc') used to become 2", () => {
    expect(() => parseRunFlags(["--rounds", "2abc"])).toThrow(/positive integer/);
  });

  it("rejects a non-integer numeric value", () => {
    expect(() => parseRunFlags(["--rounds", "2.5"])).toThrow(/positive integer/);
  });

  it("parses --dev cli:model and --review cli", () => {
    const flags = parseRunFlags(["Fix", "it", "--dev", "agy:gemini-3.8-flash", "--review", "codex"]);
    expect(flags.dev).toEqual({ cli: "agy", model: "gemini-3.8-flash" });
    expect(flags.review).toEqual({ cli: "codex" });
  });

  it("throws for an unknown CLI in --dev", () => {
    expect(() => parseRunFlags(["--dev", "notacli:foo"])).toThrow();
  });

  it("leaves an unrecognized flag in the task text (it's probably part of the task itself)", () => {
    const flags = parseRunFlags(["Run", "with", "--verbose", "flag", "enabled"]);
    expect(flags.taskText).toBe("Run with --verbose flag enabled");
  });
});

describe("extractJiraKey", () => {
  it("extracts a leading Jira key", () => {
    expect(extractJiraKey("PROJ-123 fix the login bug")).toEqual({ jiraKey: "PROJ-123", rest: "fix the login bug" });
  });

  it("returns null for text with no Jira key", () => {
    expect(extractJiraKey("fix the login bug")).toEqual({ jiraKey: null, rest: "fix the login bug" });
  });

  it("does not match a lowercase or malformed key", () => {
    expect(extractJiraKey("proj-123 fix it")).toEqual({ jiraKey: null, rest: "proj-123 fix it" });
    expect(extractJiraKey("123-PROJ fix it")).toEqual({ jiraKey: null, rest: "123-PROJ fix it" });
  });
});
