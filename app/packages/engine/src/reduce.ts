import type {
  EngineState,
  FixItem,
  GateResult,
  Issue,
  LoopSettings,
  ReviewerResult,
  TestFailure,
  TesterResult,
} from "./types.js";
import { assignIssueIds, matchPreviousIssues, updateRegistry } from "./issue-registry.js";
import {
  belowThresholdFollowUps,
  combinedFixList,
  gateShortCircuit,
  maxRoundsReached,
  severityThresholdReached,
  stuckDetection,
} from "./loop-rules.js";

export interface CurrentRound {
  developerDone: boolean;
  gate: GateResult | null;
  tester: TesterResult | null;
  reviewer: ReviewerResult | null;
}

export interface FullEngineState extends EngineState {
  current: CurrentRound;
  /** Set once a round finishes with a fix list to send back -- decide()
   * reads this to emit the next dispatch_developer Command; cleared when
   * a new round starts. */
  pendingFixList: FixItem[] | null;
  /** Accumulates across the whole task (not reset per round) -- surfaced
   * in the final report, never sent back to the developer. */
  optionalFollowUps: Issue[];
}

export type EngineEvent =
  | { type: "start"; needsDesign: boolean; loop: LoopSettings }
  | { type: "design.finished" }
  | { type: "developer.finished" }
  | { type: "gate.finished"; gate: GateResult }
  | { type: "verification.finished"; tester: TesterResult; reviewer: ReviewerResult }
  | { type: "commit.approved" }
  | { type: "commit.declined" };

const EMPTY_CURRENT: CurrentRound = { developerDone: false, gate: null, tester: null, reviewer: null };

export function initialState(): FullEngineState {
  return {
    phase: "scoping",
    round: 0,
    loop: { maxRounds: 3, fixThreshold: "major" },
    rounds: [],
    issueRegistry: [],
    needsDesign: false,
    designDone: false,
    stuckReason: null,
    current: { ...EMPTY_CURRENT },
    pendingFixList: null,
    optionalFollowUps: [],
  };
}

/** The engine's pure state transition function -- no I/O, exhaustively
 * testable. Mirrors skills/new-task/SKILL.md's numbered workflow (steps
 * 4-11, post-scoping) and lib/dispatch.md §6's loop rules, turned into
 * code instead of LLM judgment. */
export function reduce(state: FullEngineState, event: EngineEvent): FullEngineState {
  switch (event.type) {
    case "start":
      return {
        ...initialState(),
        phase: event.needsDesign ? "design" : "implementing",
        round: 1,
        loop: event.loop,
        needsDesign: event.needsDesign,
      };

    case "design.finished":
      return { ...state, phase: "implementing", designDone: true };

    case "developer.finished":
      return { ...state, current: { ...state.current, developerDone: true }, pendingFixList: null };

    case "gate.finished":
      return applyGateResult(state, event.gate);

    case "verification.finished":
      return applyVerification(state, event.tester, event.reviewer);

    case "commit.approved":
      return { ...state, phase: "done" };

    case "commit.declined":
      return { ...state, phase: "stopped", stuckReason: "user declined the commit" };
  }
}

function applyGateResult(state: FullEngineState, gate: GateResult): FullEngineState {
  const outcome = gateShortCircuit(gate);
  if (!outcome.shortCircuit) {
    // Gate passed (or nothing configured): move on to verification.
    return { ...state, phase: "verifying", current: { ...state.current, gate } };
  }
  // Gate failed: this round is done, straight back to the developer --
  // tester/reviewer never run. Still counts as a round toward max_rounds.
  const finishedRound = {
    round: state.round,
    gate,
    tester: null,
    reviewer: null,
    fixList: outcome.fixList,
  };
  const rounds = [...state.rounds, finishedRound];

  if (maxRoundsReached(state.round, state.loop.maxRounds)) {
    return { ...state, rounds, phase: "stopped", stuckReason: `gate still failing after ${state.loop.maxRounds} rounds` };
  }
  return {
    ...state,
    rounds,
    round: state.round + 1,
    phase: "fixing",
    current: { ...EMPTY_CURRENT },
    pendingFixList: outcome.fixList,
  };
}

function applyVerification(state: FullEngineState, tester: TesterResult, reviewer: ReviewerResult): FullEngineState {
  const round = state.round;
  const newIssues = assignIssueIds(round, reviewer.issues);
  const matched = matchPreviousIssues(state.issueRegistry, reviewer.previous_issues ?? []);
  const issueRegistry = updateRegistry(state.issueRegistry, round, newIssues, matched);

  const stillPresent = issueRegistry.filter((i) => i.status === "still_present");
  const needsAnotherRound = severityThresholdReached(tester, reviewer, stillPresent, state.loop.fixThreshold);
  const optionalFollowUps = [
    ...state.optionalFollowUps,
    ...belowThresholdFollowUps(newIssues, state.loop.fixThreshold),
  ];

  const finishedRound = {
    round,
    gate: state.current.gate,
    tester,
    reviewer,
    fixList: needsAnotherRound ? combinedFixList(tester, newIssues, stillPresent, state.loop.fixThreshold) : null,
  };
  const rounds = [...state.rounds, finishedRound];

  if (!needsAnotherRound) {
    return {
      ...state,
      rounds,
      issueRegistry,
      optionalFollowUps,
      phase: "awaiting_commit",
      current: { ...EMPTY_CURRENT },
      pendingFixList: null,
    };
  }

  const previousRoundFailures: TestFailure[] = findPreviousRoundFailures(state.rounds);
  const stuck = stuckDetection(issueRegistry, previousRoundFailures, tester.failures);
  if (stuck.stuck) {
    return {
      ...state,
      rounds,
      issueRegistry,
      optionalFollowUps,
      phase: "stopped",
      stuckReason: stuck.reason,
      current: { ...EMPTY_CURRENT },
      pendingFixList: null,
    };
  }
  if (maxRoundsReached(round, state.loop.maxRounds)) {
    return {
      ...state,
      rounds,
      issueRegistry,
      optionalFollowUps,
      phase: "stopped",
      stuckReason: `still failing after ${state.loop.maxRounds} rounds`,
      current: { ...EMPTY_CURRENT },
      pendingFixList: null,
    };
  }

  return {
    ...state,
    rounds,
    issueRegistry,
    optionalFollowUps,
    round: round + 1,
    phase: "fixing",
    current: { ...EMPTY_CURRENT },
    pendingFixList: finishedRound.fixList,
  };
}

function findPreviousRoundFailures(rounds: FullEngineState["rounds"]): TestFailure[] {
  for (let i = rounds.length - 1; i >= 0; i--) {
    const tester = rounds[i]?.tester;
    if (tester) return tester.failures;
  }
  return [];
}
