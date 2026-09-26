import type { ApprovalDecision, ApprovalProvider, ApprovalRequest, IntegrateMode } from "@crewbench/engine";
import { ask, confirm } from "./prompt.js";

/** The terminal-backed `ApprovalProvider` `crewbench run`/`resume` pass
 * to `driveTask()` -- reproduces the exact prompt text/order the CLI
 * asked before `driveTask()` moved into `packages/engine` (Phase 3
 * milestone 1), so this is a pure refactor for the CLI's own users: same
 * questions, same order, same defaults. */
export function createTerminalApprovalProvider(): ApprovalProvider {
  return {
    async request(approval: ApprovalRequest): Promise<ApprovalDecision> {
      switch (approval.kind) {
        case "commit": {
          const payload = approval.payload as { title: string; diffStat: string | null };
          const yes = await confirm("Commit this work?", true);
          if (!yes) return { decision: "no" };
          const message = await ask(`Commit message [${payload.title}]: `);
          return { decision: "yes", data: { message: message || payload.title } };
        }
        case "integrate": {
          const choice = (await ask("Bring it back how? [merge/cherry-pick/leave/none]: ")).toLowerCase() as IntegrateMode;
          return { decision: "custom", data: { choice } };
        }
        case "cleanup_worktree": {
          const yes = await confirm("Remove the worktree now?", false);
          return { decision: yes ? "yes" : "no" };
        }
        default:
          // Every other kind (confirm_profile, lineup, design, dirty_tree,
          // worktree_setup, push) is still asked ad hoc, outside
          // driveTask(), by run.ts/resume.ts directly -- see
          // docs/app/phase-3-plan.md's milestone 1 scope. Not reachable
          // through driveTask() today; a safe default rather than a thrown
          // error, since a future kind added to APPROVAL_KINDS without a
          // matching case here should degrade, not crash the loop.
          return { decision: "no" };
      }
    },
  };
}
