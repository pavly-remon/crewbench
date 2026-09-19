import type { ApprovalDecision, ApprovalProvider, ApprovalRequest } from "@crewbench/engine";

interface Pending {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

/** The daemon's own `ApprovalProvider` (Phase 3 milestone 1's Design
 * decision 1): `driveTask()`'s `request()` call resolves only once
 * `resolve(id, decision)` is called from outside -- by
 * `POST /api/tasks/:tid/approvals/:aid` (milestone 5 wires that route
 * up; this class just holds the pending state either way). One instance
 * per active task, owned by `TaskRunner`. Never auto-resolves anything
 * itself -- the human decision has to come from a real HTTP call, same
 * as the terminal provider requires a real keypress. */
export class HttpApprovalProvider implements ApprovalProvider {
  private pending = new Map<string, Pending>();

  request(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.pending.set(request.id, { request, resolve });
    });
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  resolve(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(decision);
    return true;
  }
}
