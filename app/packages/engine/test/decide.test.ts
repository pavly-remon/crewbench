import { describe, expect, it } from "vitest";
import { decide } from "../src/decide.js";
import { initialState, reduce } from "../src/reduce.js";
import type { GateResult, ReviewerResult, TesterResult } from "../src/types.js";

const PASS_GATE: GateResult = { ok: true, steps: [] };
const PASS_TESTER: TesterResult = { verdict: "pass", failures: [] };
const APPROVE_REVIEWER: ReviewerResult = { verdict: "approve", issues: [] };

describe("decide", () => {
  it("scoping: waits (scoping is driven externally)", () => {
    expect(decide(initialState())).toEqual([{ type: "wait" }]);
  });

  it("design: dispatches design when not yet done", () => {
    const state = reduce(initialState(), { type: "start", needsDesign: true, loop: { maxRounds: 3, fixThreshold: "major" } });
    expect(decide(state)).toEqual([{ type: "dispatch_design" }]);
  });

  it("implementing: dispatches the developer before it's done", () => {
    const state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    expect(decide(state)).toEqual([{ type: "dispatch_developer", round: 1, fixList: null }]);
  });

  it("implementing: runs the gate once the developer is done", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    expect(decide(state)).toEqual([{ type: "run_gate", round: 1 }]);
  });

  it("fixing: dispatches the developer with the pending fix list", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, {
      type: "gate.finished",
      gate: { ok: false, steps: [{ name: "test", command: "npm test", exit_code: 1, duration_s: 1, timed_out: false, output_tail: "fail" }] },
    });
    const commands = decide(state);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "dispatch_developer", round: 2 });
  });

  it("verifying: dispatches tester+reviewer in parallel (one Command, not two)", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    expect(decide(state)).toEqual([{ type: "dispatch_verification", round: 1 }]);
  });

  it("awaiting_commit: requests a commit approval", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    state = reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer: APPROVE_REVIEWER });
    expect(decide(state)).toEqual([{ type: "request_commit_approval" }]);
  });

  it("done: finishes with outcome done", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, { type: "gate.finished", gate: PASS_GATE });
    state = reduce(state, { type: "verification.finished", tester: PASS_TESTER, reviewer: APPROVE_REVIEWER });
    state = reduce(state, { type: "commit.approved" });
    expect(decide(state)).toEqual([{ type: "finish", outcome: "done", reason: null }]);
  });

  it("stopped: finishes with outcome stopped and the reason", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 1, fixThreshold: "major" } });
    state = reduce(state, { type: "developer.finished" });
    state = reduce(state, {
      type: "gate.finished",
      gate: { ok: false, steps: [{ name: "test", command: "npm test", exit_code: 1, duration_s: 1, timed_out: false, output_tail: "fail" }] },
    });
    const commands = decide(state);
    expect(commands[0]).toMatchObject({ type: "finish", outcome: "stopped" });
    expect((commands[0] as { reason: string }).reason).toContain("gate");
  });
});
