import type { RoleName, TaskPhase } from "@crewbench/contract";

export type { TaskPhase };
export const TASK_PHASES = [
  "scoping",
  "design",
  "implementing",
  "verifying",
  "fixing",
  "awaiting_commit",
  "done",
  "stopped",
  "failed",
] as const;

export type Severity = "blocker" | "major" | "minor";
export const SEVERITY_RANK: Record<Severity, number> = { minor: 1, major: 2, blocker: 3 };

export interface LoopSettings {
  maxRounds: number;
  fixThreshold: Severity;
}

export interface GateStepResult {
  name: string;
  command: string;
  exit_code: number | null;
  duration_s: number;
  timed_out: boolean;
  output_tail: string;
}
export interface GateResult {
  ok: boolean;
  steps: GateStepResult[];
}

export interface TestFailure {
  test: string;
  file: string;
  expected: string;
  actual: string;
  reason: string;
}
export interface TesterResult {
  verdict: "pass" | "fail" | "error";
  failures: TestFailure[];
}

/** A raw issue as reported by the code-reviewer this round, before the
 * engine's issue registry assigns it a stable id. */
export interface RawIssue {
  file: string;
  line: number | null;
  severity: Severity;
  category: string;
  change: string;
}

/** An issue once the registry has assigned it an id (round-scoped,
 * "R<round>-<n>") -- this is the shape sent to the reviewer and stored in
 * state.json.rounds[].issues, matching schemas/code-reviewer.json's
 * `issues[]`. */
export interface Issue extends RawIssue {
  id: string;
}

export interface PreviousIssueStatus {
  id: string;
  status: "resolved" | "still_present";
  note: string;
}

export interface ReviewerResult {
  verdict: "approve" | "changes_requested";
  issues: RawIssue[];
  previous_issues?: PreviousIssueStatus[];
}

/** One combined fix-list item -- either a tester failure or a
 * still-relevant reviewer issue, merged per lib/dispatch.md §6's "one
 * combined fix list" rule. */
export type FixItem = { kind: "test_failure"; failure: TestFailure } | { kind: "issue"; issue: Issue };

/** The engine's per-issue bookkeeping across rounds -- this is the "issue
 * registry" docs/app/phase-1-plan.md's milestone 3 describes: the engine,
 * not the reviewer, owns identity. */
export interface RegisteredIssue {
  id: string;
  firstSeenRound: number;
  file: string;
  category: string;
  severity: Severity;
  change: string;
  status: "open" | "resolved" | "still_present";
  /** Consecutive rounds this issue has been reported still_present --
   * stuckDetection() reads this to trigger the oscillation rule. */
  consecutiveStillPresent: number;
}

export interface RoundRecord {
  round: number;
  gate: GateResult | null;
  tester: TesterResult | null;
  reviewer: ReviewerResult | null;
  fixList: FixItem[] | null;
}

export interface EngineState {
  phase: TaskPhase;
  round: number;
  loop: LoopSettings;
  rounds: RoundRecord[];
  /** Every issue the registry has ever assigned an id to, across all
   * rounds -- not just the current round's. */
  issueRegistry: RegisteredIssue[];
  needsDesign: boolean;
  designDone: boolean;
  stuckReason: string | null;
}

export type Role = RoleName;
