import { describe, expect, it } from "vitest";
import {
  belowThresholdFollowUps,
  combinedFixList,
  gateShortCircuit,
  maxRoundsReached,
  severityThresholdReached,
  stuckDetection,
} from "../src/loop-rules.js";
import type { GateResult, Issue, RegisteredIssue, ReviewerResult, TestFailure, TesterResult } from "../src/types.js";

// Every rule ported here has its own named test(s), per lib/dispatch.md §6
// and docs/app/phase-1-plan.md's milestone 3 acceptance bar.

describe("gateShortCircuit (lib/dispatch.md §6 'Deterministic gate')", () => {
  it("a passing gate does not short-circuit", () => {
    const gate: GateResult = { ok: true, steps: [{ name: "lint", command: "eslint .", exit_code: 0, duration_s: 1, timed_out: false, output_tail: "" }] };
    expect(gateShortCircuit(gate)).toEqual({ shortCircuit: false });
  });

  it("no configured steps does not short-circuit", () => {
    expect(gateShortCircuit({ ok: true, steps: [] })).toEqual({ shortCircuit: false });
  });

  it("a failing gate short-circuits with the failing step's output_tail as the fix list, skipping tester/reviewer", () => {
    const gate: GateResult = {
      ok: false,
      steps: [
        { name: "lint", command: "eslint .", exit_code: 0, duration_s: 1, timed_out: false, output_tail: "" },
        { name: "typecheck", command: "tsc --noEmit", exit_code: 1, duration_s: 2, timed_out: false, output_tail: "src/x.ts(1,1): error TS2304" },
      ],
    };
    const result = gateShortCircuit(gate);
    expect(result.shortCircuit).toBe(true);
    if (result.shortCircuit) {
      expect(result.fixList).toHaveLength(1);
      expect(result.fixList[0]).toEqual({
        kind: "test_failure",
        failure: {
          test: "typecheck",
          file: "tsc --noEmit",
          expected: "exit code 0",
          actual: "exit code 1",
          reason: "src/x.ts(1,1): error TS2304",
        },
      });
    }
  });

  it("a timed-out gate step reports timed out, not an exit code", () => {
    const gate: GateResult = {
      ok: false,
      steps: [{ name: "test", command: "npm test", exit_code: null, duration_s: 600, timed_out: true, output_tail: "" }],
    };
    const result = gateShortCircuit(gate);
    expect(result.shortCircuit).toBe(true);
    if (result.shortCircuit) expect(result.fixList[0]).toMatchObject({ failure: { actual: "timed out" } });
  });
});

describe("severityThresholdReached (lib/dispatch.md §6 'Severity threshold')", () => {
  const passingTester: TesterResult = { verdict: "pass", failures: [] };
  const approveReviewer: ReviewerResult = { verdict: "approve", issues: [] };

  it("does not trigger when the tester passes and the reviewer has no issues", () => {
    expect(severityThresholdReached(passingTester, approveReviewer, [], "major")).toBe(false);
  });

  it("triggers on any tester failure, regardless of the reviewer", () => {
    const failing: TesterResult = { verdict: "fail", failures: [{ test: "t", file: "a.ts", expected: "1", actual: "2", reason: "r" }] };
    expect(severityThresholdReached(failing, approveReviewer, [], "major")).toBe(true);
  });

  it("triggers when a new issue is at or above fix_threshold", () => {
    const reviewer: ReviewerResult = {
      verdict: "changes_requested",
      issues: [{ file: "a.ts", line: 1, severity: "major", category: "correctness", change: "fix it" }],
    };
    expect(severityThresholdReached(passingTester, reviewer, [], "major")).toBe(true);
  });

  it("does not trigger when the only new issue is below fix_threshold", () => {
    const reviewer: ReviewerResult = {
      verdict: "changes_requested",
      issues: [{ file: "a.ts", line: 1, severity: "minor", category: "consistency", change: "nit" }],
    };
    expect(severityThresholdReached(passingTester, reviewer, [], "major")).toBe(false);
  });

  it("triggers when a still_present registered issue is at or above fix_threshold", () => {
    const registered: RegisteredIssue = {
      id: "R1-1",
      firstSeenRound: 1,
      file: "a.ts",
      category: "correctness",
      severity: "blocker",
      change: "fix it",
      status: "still_present",
      consecutiveStillPresent: 1,
    };
    const reviewer: ReviewerResult = {
      verdict: "changes_requested",
      issues: [],
      previous_issues: [{ id: "R1-1", status: "still_present", note: "still broken" }],
    };
    expect(severityThresholdReached(passingTester, reviewer, [registered], "major")).toBe(true);
  });

  it("severity ranks: blocker > major > minor", () => {
    const majorIssue: ReviewerResult = { verdict: "changes_requested", issues: [{ file: "a", line: null, severity: "major", category: "correctness", change: "x" }] };
    expect(severityThresholdReached(passingTester, majorIssue, [], "blocker")).toBe(false);
    expect(severityThresholdReached(passingTester, majorIssue, [], "major")).toBe(true);
    expect(severityThresholdReached(passingTester, majorIssue, [], "minor")).toBe(true);
  });
});

describe("combinedFixList (lib/dispatch.md §6 'one combined fix list')", () => {
  it("merges tester failures and at-or-above-threshold reviewer issues into one list", () => {
    const tester: TesterResult = { verdict: "fail", failures: [{ test: "t1", file: "a.ts", expected: "1", actual: "2", reason: "r" }] };
    const issues: Issue[] = [
      { id: "R2-1", file: "b.ts", line: 1, severity: "blocker", category: "security", change: "fix" },
      { id: "R2-2", file: "c.ts", line: 2, severity: "minor", category: "consistency", change: "nit" },
    ];
    const list = combinedFixList(tester, issues, [], "major");
    expect(list).toHaveLength(2); // the test failure + the blocker issue, not the minor one
    expect(list.some((i) => i.kind === "test_failure")).toBe(true);
    expect(list.filter((i) => i.kind === "issue")).toHaveLength(1);
  });

  it("includes still-present registered issues at or above threshold", () => {
    const tester: TesterResult = { verdict: "pass", failures: [] };
    const stillPresent: RegisteredIssue[] = [
      { id: "R1-1", firstSeenRound: 1, file: "a.ts", category: "correctness", severity: "major", change: "fix", status: "still_present", consecutiveStillPresent: 1 },
    ];
    const list = combinedFixList(tester, [], stillPresent, "major");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "issue", issue: { id: "R1-1" } });
  });
});

describe("belowThresholdFollowUps (lib/dispatch.md §6 'optional follow-ups')", () => {
  it("collects issues below fix_threshold, never at or above it", () => {
    const issues: Issue[] = [
      { id: "R1-1", file: "a.ts", line: 1, severity: "minor", category: "consistency", change: "nit" },
      { id: "R1-2", file: "b.ts", line: 2, severity: "major", category: "correctness", change: "fix" },
    ];
    const followUps = belowThresholdFollowUps(issues, "major");
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.id).toBe("R1-1");
  });
});

describe("maxRoundsReached (lib/dispatch.md §6 'Cap rounds at loop.max_rounds')", () => {
  it("is false under the cap, true at or over it", () => {
    expect(maxRoundsReached(1, 3)).toBe(false);
    expect(maxRoundsReached(2, 3)).toBe(false);
    expect(maxRoundsReached(3, 3)).toBe(true);
    expect(maxRoundsReached(4, 3)).toBe(true);
  });
});

describe("stuckDetection (lib/dispatch.md §6 'Oscillation')", () => {
  it("is not stuck with no repeats", () => {
    expect(stuckDetection([], [], [])).toEqual({ stuck: false, reason: null });
  });

  it("flags an issue still_present for two consecutive rounds", () => {
    const registry: RegisteredIssue[] = [
      { id: "R1-1", firstSeenRound: 1, file: "a.ts", category: "correctness", severity: "major", change: "fix", status: "still_present", consecutiveStillPresent: 2 },
    ];
    const result = stuckDetection(registry, [], []);
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("R1-1");
  });

  it("does not flag an issue still_present for only one round", () => {
    const registry: RegisteredIssue[] = [
      { id: "R1-1", firstSeenRound: 1, file: "a.ts", category: "correctness", severity: "major", change: "fix", status: "still_present", consecutiveStillPresent: 1 },
    ];
    expect(stuckDetection(registry, [], []).stuck).toBe(false);
  });

  it("flags the same test+file failing two rounds in a row", () => {
    const previous: TestFailure[] = [{ test: "test_login", file: "auth.test.ts", expected: "200", actual: "500", reason: "r" }];
    const current: TestFailure[] = [{ test: "test_login", file: "auth.test.ts", expected: "200", actual: "500", reason: "different reason this time" }];
    const result = stuckDetection([], previous, current);
    expect(result.stuck).toBe(true);
    expect(result.reason).toContain("test_login");
  });

  it("does not flag a different test failing, or the same test in a different file", () => {
    const previous: TestFailure[] = [{ test: "test_login", file: "auth.test.ts", expected: "200", actual: "500", reason: "r" }];
    const differentTest: TestFailure[] = [{ test: "test_logout", file: "auth.test.ts", expected: "200", actual: "500", reason: "r" }];
    const differentFile: TestFailure[] = [{ test: "test_login", file: "other.test.ts", expected: "200", actual: "500", reason: "r" }];
    expect(stuckDetection([], previous, differentTest).stuck).toBe(false);
    expect(stuckDetection([], previous, differentFile).stuck).toBe(false);
  });
});
