import { DispatchCancelledError, type ApprovalDecision, type ApprovalProvider, type ApprovalRequest } from "@crewbench/engine";

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

  /** `signal` firing while this request is still pending removes it
   * from `pending` (so a later, stray `POST .../approvals/:aid` for the
   * same id 404s instead of silently resolving nothing, or worse,
   * resolving a decision nobody's still awaiting) and rejects with
   * `DispatchCancelledError` -- see that error's own docstring
   * (`concurrency.ts`) for the real cancellation bug this closes. */
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DispatchCancelledError());
        return;
      }
      const onAbort = (): void => {
        this.pending.delete(request.id);
        reject(new DispatchCancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, {
        request,
        resolve: (decision) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(decision);
        },
      });
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
