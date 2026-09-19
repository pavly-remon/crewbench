import type { ApprovalDecision, ApprovalRequest } from "./approvals.js";

/** Answers one pending `ApprovalRequest` with a real decision -- the
 * abstraction `driveTask()` uses instead of importing a terminal
 * `ask()`/`confirm()` directly (Phase 3 milestone 1's Design decision 1:
 * `docs/app/phase-3-plan.md`). `packages/cli` implements this with real
 * terminal prompts (`terminal-approvals.ts`), preserving `crewbench
 * run`/`resume`'s exact interactive behavior; `packages/daemon`
 * implements it by holding the request in memory until a
 * `POST /api/tasks/:tid/approvals/:aid` call resolves it. Either way, the
 * request always reaches a real decision-maker -- there is no "auto"
 * implementation of this interface anywhere in this codebase, matching
 * `docs/app/CONTEXT.md`'s non-negotiable principle 3. */
export interface ApprovalProvider {
  request(approval: ApprovalRequest): Promise<ApprovalDecision>;
}
