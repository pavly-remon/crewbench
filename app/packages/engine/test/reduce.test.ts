import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../src/reduce.js";
import type { GateResult, ReviewerResult, TesterResult } from "../src/types.js";

const PASS_GATE: GateResult = { ok: true, steps: [] };
const FAIL_GATE: GateResult = {
  ok: false,
  steps: [{ name: "test", command: "npm test", exit_code: 1, duration_s: 5, timed_out: false, output_tail: "1 failing" }],
};
const PASS_TESTER: TesterResult = { verdict: "pass", failures: [] };
const APPROVE_REVIEWER: ReviewerResult = { verdict: "approve", issues: [] };

describe("reduce: happy path (no design, gate passes, verification approves)", () => {
  it("goes scoping -> implementing -> verifying -> awaiting_commit -> done", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    expect(state.phase).toBe("implementing");
    expect(state.round).toBe(1);

    state = reduce(state, { type: "developer.finished" });
    expect(state.current.developerDone).toBe(true);

    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    expect(state.phase).toBe("verifying");

    state = reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer: APPROVE_REVIEWER });
    expect(state.phase).toBe("awaiting_commit");
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]?.fixList).toBeNull();

    state = reduce(state, { type: "commit.approved" });
    expect(state.phase).toBe("done");
  });
});

describe("reduce: design opt-in", () => {
  it("starts in the design phase and waits for design.finished before implementing", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: true, loop: { maxRounds: 3, fixThreshold: "major" } });
    expect(state.phase).toBe("design");
    expect(state.designDone).toBe(false);

    state = reduce(state, { type: "design.finished" });
    expect(state.phase).toBe("implementing");
    expect(state.designDone).toBe(true);
  });
});

describe("reduce: gate failure loop", () => {
  it("a failing gate advances the round, sets phase to fixing, and records the round with no tester/reviewer", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: FAIL_GATE });

    expect(state.phase).toBe("fixing");
    expect(state.round).toBe(2);
    expect(state.current.developerDone).toBe(false); // fresh round
    expect(state.pendingFixList).toHaveLength(1);
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]).toMatchObject({ round: 1, tester: null, reviewer: null });
  });

  it("stops (not fails) after max_rounds of a failing gate", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 2, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: FAIL_GATE }); // round 1 -> round 2
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: FAIL_GATE }); // round 2 hits the cap

    expect(state.phase).toBe("stopped");
    expect(state.stuckReason).toContain("gate");
  });
});

describe("reduce: verification fix loop", () => {
  function afterRound1WithIssue(fixThreshold: "blocker" | "major" | "minor" = "major") {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    const reviewer: ReviewerResult = {
      verdict: "changes_requested",
      issues: [{ file: "a.ts", line: 1, severity: "major", category: "correctness", change: "fix the bug" }],
    };
    return reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer });
  }

  it("an at-or-above-threshold issue advances to round 2 in the fixing phase with a fix list", () => {
    const state = afterRound1WithIssue();
    expect(state.phase).toBe("fixing");
    expect(state.round).toBe(2);
    expect(state.pendingFixList).toHaveLength(1);
    expect(state.pendingFixList?.[0]).toMatchObject({ kind: "issue", issue: { id: "R1-1" } });
  });

  it("registers the issue so round 2 can track its previous_issues status", () => {
    const state = afterRound1WithIssue();
    expect(state.issueRegistry).toHaveLength(1);
    expect(state.issueRegistry[0]).toMatchObject({ id: "R1-1", status: "open" });
  });

  it("a below-threshold issue goes to awaiting_commit with it recorded as an optional follow-up, not a fix round", () => {
    const state = afterRound1WithIssue("blocker"); // "major" severity issue is below a "blocker" threshold
    expect(state.phase).toBe("awaiting_commit");
    expect(state.optionalFollowUps).toHaveLength(1);
  });

  it("round 2 resolving the issue goes to awaiting_commit", () => {
    let state = afterRound1WithIssue();
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    const reviewer: ReviewerResult = {
      verdict: "approve",
      issues: [],
      previous_issues: [{ id: "R1-1", status: "resolved", note: "fixed" }],
    };
    state = reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer });
    expect(state.phase).toBe("awaiting_commit");
    expect(state.issueRegistry.find((i) => i.id === "R1-1")?.status).toBe("resolved");
  });

  it("the same issue still_present for two consecutive rounds stops the task as stuck", () => {
    // Round 1 finds the issue (new, not yet "still_present" anywhere).
    // Round 2's reviewer reports it still_present for the first time --
    // one round of being still_present is not yet oscillation. Only once
    // round 3 *also* reports it still_present (two consecutive
    // still_present verdicts) does the rule trigger.
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 5, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    const reviewerRound1: ReviewerResult = {
      verdict: "changes_requested",
      issues: [{ file: "a.ts", line: 1, severity: "major", category: "correctness", change: "fix the bug" }],
    };
    state = reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer: reviewerRound1 });
    expect(state.phase).toBe("fixing");

    const stillPresent: ReviewerResult = {
      verdict: "changes_requested",
      issues: [],
      previous_issues: [{ id: "R1-1", status: "still_present", note: "still broken" }],
    };
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    state = reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer: stillPresent });
    expect(state.phase).toBe("fixing"); // first still_present report: not stuck yet

    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    state = reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer: stillPresent });
    expect(state.phase).toBe("stopped"); // second consecutive still_present report: stuck
    expect(state.stuckReason).toContain("R1-1");
  });

  it("the same failing test two rounds in a row stops the task as stuck", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 5, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    const failure = { test: "test_login", file: "auth.test.ts", expected: "200", actual: "500", reason: "r" };
    state = reduce(state, {
      type: "verification.finished",
      tester: { verdict: "fail", failures: [failure] },
      reviewer: APPROVE_REVIEWER,
    });
    expect(state.phase).toBe("fixing");

    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    state = reduce(state, {
      type: "verification.finished",
      tester: { verdict: "fail", failures: [failure] },
      reviewer: APPROVE_REVIEWER,
    });
    expect(state.phase).toBe("stopped");
    expect(state.stuckReason).toContain("test_login");
  });

  it("stops at max_rounds without oscillation, reporting exactly that", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 1, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    const reviewer: ReviewerResult = {
      verdict: "changes_requested",
      issues: [{ file: "a.ts", line: 1, severity: "major", category: "correctness", change: "fix" }],
    };
    state = reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer });
    expect(state.phase).toBe("stopped");
    expect(state.stuckReason).toContain("1 round");
  });
});
