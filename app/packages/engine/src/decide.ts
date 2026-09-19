import type { FixItem } from "./types.js";
import type { FullEngineState } from "./reduce.js";

export type Command =
  | { type: "dispatch_design" }
  | { type: "dispatch_developer"; round: number; fixList: FixItem[] | null }
  | { type: "run_gate"; round: number }
  | { type: "dispatch_verification"; round: number }
  | { type: "request_commit_approval" }
  | { type: "finish"; outcome: "done" | "stopped" | "failed"; reason: string | null }
  | { type: "wait" };

/** The engine's pure decision function -- no I/O, exhaustively testable.
 * Given the current state alone (not the event that produced it), returns
 * what the runner should do next. Called after every reduce(). */
export function decide(state: FullEngineState): Command[] {
  switch (state.phase) {
    case "scoping":
      return [{ type: "wait" }]; // scoping is driven by the (later-milestone) LLM scoping flow, not this state machine

    case "design":
      return state.designDone ? [{ type: "wait" }] : [{ type: "dispatch_design" }];

    case "implementing":
    case "fixing":
      if (!state.current.developerDone) {
        return [{ type: "dispatch_developer", round: state.round, fixList: state.pendingFixList }];
      }
      if (!state.current.gate) {
        return [{ type: "run_gate", round: state.round }];
      }
      return [{ type: "wait" }]; // gate passed; reduce() already moved phase to "verifying"

    case "verifying":
      if (!state.current.tester || !state.current.reviewer) {
        return [{ type: "dispatch_verification", round: state.round }];
      }
      return [{ type: "wait" }]; // reduce() already merged this into the next phase

    case "awaiting_commit":
      return [{ type: "request_commit_approval" }];

    case "done":
      return [{ type: "finish", outcome: "done", reason: null }];

    case "stopped":
      return [{ type: "finish", outcome: "stopped", reason: state.stuckReason }];

    case "failed":
      return [{ type: "finish", outcome: "failed", reason: state.stuckReason }];
  }
}
