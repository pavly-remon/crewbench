import { describe, expect, it } from "vitest";
import { assignIssueIds, matchPreviousIssues, updateRegistry } from "../src/issue-registry.js";
import type { RawIssue, RegisteredIssue } from "../src/types.js";

describe("assignIssueIds", () => {
  it("numbers issues R<round>-<n>, engine-assigned regardless of the role's own numbering", () => {
    const raw: RawIssue[] = [
      { file: "a.ts", line: 1, severity: "major", category: "correctness", change: "fix a" },
      { file: "b.ts", line: 2, severity: "minor", category: "consistency", change: "fix b" },
    ];
    const issues = assignIssueIds(1, raw);
    expect(issues[0]?.id).toBe("R1-1");
    expect(issues[1]?.id).toBe("R1-2");

    const round2 = assignIssueIds(2, raw);
    expect(round2[0]?.id).toBe("R2-1");
  });
});

describe("matchPreviousIssues", () => {
  const registryEntry: RegisteredIssue = {
    id: "R1-1",
    firstSeenRound: 1,
    file: "a.ts",
    category: "correctness",
    severity: "major",
    change: "off-by-one error in the loop bound",
    status: "open",
    consecutiveStillPresent: 0,
  };

  it("matches by id when the reviewer echoes it back correctly", () => {
    const matched = matchPreviousIssues([registryEntry], [{ id: "R1-1", status: "resolved", note: "fixed" }]);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.method).toBe("id");
    expect(matched[0]?.status).toBe("resolved");
  });

  it("falls back to file+category+similar title when the id doesn't match anything open", () => {
    const matched = matchPreviousIssues(
      [registryEntry],
      [{ id: "R1-99", status: "still_present", note: "still an off-by-one error in the loop bound" }],
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.method).toBe("file+category+title");
    expect(matched[0]?.registryEntry.id).toBe("R1-1");
  });

  it("does not match an already-resolved registry entry", () => {
    const resolved: RegisteredIssue = { ...registryEntry, status: "resolved" };
    const matched = matchPreviousIssues([resolved], [{ id: "R1-1", status: "still_present", note: "x" }]);
    expect(matched).toHaveLength(0);
  });

  it("leaves an unrecognizable previous_issues entry unmatched rather than guessing", () => {
    const matched = matchPreviousIssues(
      [registryEntry],
      [{ id: "R9-9", status: "resolved", note: "something completely unrelated to anything" }],
    );
    expect(matched).toHaveLength(0);
  });
});

describe("updateRegistry", () => {
  it("adds new issues as open entries", () => {
    const registry = updateRegistry([], 1, [{ id: "R1-1", file: "a.ts", line: 1, severity: "major", category: "correctness", change: "fix" }], []);
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({ id: "R1-1", status: "open", consecutiveStillPresent: 0, firstSeenRound: 1 });
  });

  it("marks a matched entry resolved and resets its streak", () => {
    const entry: RegisteredIssue = {
      id: "R1-1",
      firstSeenRound: 1,
      file: "a.ts",
      category: "correctness",
      severity: "major",
      change: "fix",
      status: "still_present",
      consecutiveStillPresent: 1,
    };
    const registry = updateRegistry([entry], 2, [], [{ registryEntry: entry, status: "resolved", method: "id" }]);
    expect(registry[0]).toMatchObject({ status: "resolved", consecutiveStillPresent: 0 });
  });

  it("increments the still_present streak on a repeated still_present verdict", () => {
    const entry: RegisteredIssue = {
      id: "R1-1",
      firstSeenRound: 1,
      file: "a.ts",
      category: "correctness",
      severity: "major",
      change: "fix",
      status: "still_present",
      consecutiveStillPresent: 1,
    };
    const registry = updateRegistry([entry], 2, [], [{ registryEntry: entry, status: "still_present", method: "id" }]);
    expect(registry[0]?.consecutiveStillPresent).toBe(2);
  });

  it("leaves an unmentioned entry's status and streak unchanged", () => {
    const entry: RegisteredIssue = {
      id: "R1-1",
      firstSeenRound: 1,
      file: "a.ts",
      category: "correctness",
      severity: "major",
      change: "fix",
      status: "open",
      consecutiveStillPresent: 0,
    };
    const registry = updateRegistry([entry], 2, [], []);
    expect(registry[0]).toEqual(entry);
  });
});
