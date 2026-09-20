import { useState } from "react";
import type { ApiPendingApproval } from "@crewbench/contract";
import { Button } from "./button.js";
import { DiffViewer } from "./diff-viewer.js";
import { useTaskDiff } from "../api/task-detail.js";
import { useResolveApproval } from "../api/approvals.js";

const KIND_LABELS: Record<string, string> = {
  confirm_profile: "Confirm project profile",
  lineup: "Confirm lineup",
  design: "Use the UI/UX role?",
  dirty_tree: "Uncommitted changes",
  worktree_setup: "Worktree setup",
  commit: "Commit",
  push: "Push",
  integrate: "Bring work back",
  cleanup_worktree: "Remove worktree",
};

/** One card per pending approval (Phase 3 milestone 5) -- dispatches on
 * `kind` to a bespoke render for the three kinds any caller of
 * `driveTask()` actually issues today (`commit`, `integrate`,
 * `cleanup_worktree` -- see `routes/approvals.ts`'s own docstring for
 * why the other six names in `ApiApprovalKindSchema` never reach this
 * component in practice), falling back to a generic kind+payload+yes/no
 * card for any other kind so this stays correct rather than crashing if
 * one is ever actually issued.
 *
 * **No card here, for any kind, renders an "always allow" control**:
 * there is no such capability anywhere in this codebase for the daemon
 * to honor even if the UI offered one (see `ApiResolveApprovalRequestSchema`'s
 * own docstring in `@crewbench/contract`) -- so this isn't a special
 * case for `commit`/`push`, it's simply what every card looks like. */
export function ApprovalCard({ approval }: { approval: ApiPendingApproval }) {
  switch (approval.kind) {
    case "commit":
      return <CommitCard approval={approval} />;
    case "integrate":
      return <IntegrateCard approval={approval} />;
    case "cleanup_worktree":
      return <CleanupWorktreeCard approval={approval} />;
    default:
      return <GenericCard approval={approval} />;
  }
}

function CardShell({ approval, children }: { approval: ApiPendingApproval; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{KIND_LABELS[approval.kind] ?? approval.kind}</span>
        <span className="text-xs text-[var(--color-fg-muted)]">{approval.title}</span>
      </div>
      {children}
    </div>
  );
}

function CommitCard({ approval }: { approval: ApiPendingApproval }) {
  const payload = approval.payload as { title?: string; diffStat?: string | null };
  const resolve = useResolveApproval(approval.task_id);
  const { data: diff } = useTaskDiff(approval.task_id, "base");
  const [message, setMessage] = useState(payload.title ?? approval.title);

  return (
    <CardShell approval={approval}>
      {payload.diffStat && <pre className="overflow-x-auto rounded bg-[var(--color-bg-subtle)] p-2 text-xs">{payload.diffStat}</pre>}
      <details className="text-xs">
        <summary className="cursor-pointer text-[var(--color-fg-muted)]">Full diff</summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <DiffViewer diff={diff?.diff ?? ""} />
        </div>
      </details>
      <label className="flex flex-col gap-1 text-xs">
        Commit message
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate({ approvalId: approval.id, decision: "no" })}>
          Don't commit
        </Button>
        <Button
          variant="primary"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ approvalId: approval.id, decision: "yes", data: { message } })}
        >
          Commit
        </Button>
      </div>
      {resolve.isError && <p className="text-xs text-red-500">{resolve.error.message}</p>}
    </CardShell>
  );
}

function IntegrateCard({ approval }: { approval: ApiPendingApproval }) {
  const payload = approval.payload as { branch?: string };
  const resolve = useResolveApproval(approval.task_id);
  const choose = (choice: "merge" | "cherry-pick" | "leave" | "none") => resolve.mutate({ approvalId: approval.id, decision: "custom", data: { choice } });

  return (
    <CardShell approval={approval}>
      <p className="text-xs text-[var(--color-fg-muted)]">Bring `{payload.branch ?? "this branch"}`'s work back onto the original branch how?</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={resolve.isPending} onClick={() => choose("none")}>
          Leave it
        </Button>
        <Button variant="secondary" disabled={resolve.isPending} onClick={() => choose("cherry-pick")}>
          Cherry-pick
        </Button>
        <Button variant="primary" disabled={resolve.isPending} onClick={() => choose("merge")}>
          Merge
        </Button>
      </div>
      {resolve.isError && <p className="text-xs text-red-500">{resolve.error.message}</p>}
    </CardShell>
  );
}

function CleanupWorktreeCard({ approval }: { approval: ApiPendingApproval }) {
  const payload = approval.payload as { worktree?: string };
  const resolve = useResolveApproval(approval.task_id);

  return (
    <CardShell approval={approval}>
      <p className="text-xs text-[var(--color-fg-muted)] break-all">Remove the worktree at `{payload.worktree ?? "unknown"}` now?</p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate({ approvalId: approval.id, decision: "no" })}>
          Keep it
        </Button>
        <Button variant="primary" disabled={resolve.isPending} onClick={() => resolve.mutate({ approvalId: approval.id, decision: "yes" })}>
          Remove
        </Button>
      </div>
      {resolve.isError && <p className="text-xs text-red-500">{resolve.error.message}</p>}
    </CardShell>
  );
}

/** Fallback for any `ApprovalKind` with no bespoke card above --
 * `confirm_profile`/`lineup`/`design`/`dirty_tree`/`worktree_setup`/
 * `push` today, none of which `driveTask()` actually issues as of this
 * milestone (see `ApprovalCard`'s own docstring), kept generic rather
 * than omitted so this component is already correct the moment a future
 * change makes one of them real. */
function GenericCard({ approval }: { approval: ApiPendingApproval }) {
  const resolve = useResolveApproval(approval.task_id);
  return (
    <CardShell approval={approval}>
      <pre className="max-h-32 overflow-y-auto rounded bg-[var(--color-bg-subtle)] p-2 text-xs whitespace-pre-wrap">
        {JSON.stringify(approval.payload, null, 2)}
      </pre>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate({ approvalId: approval.id, decision: "no" })}>
          No
        </Button>
        <Button variant="primary" disabled={resolve.isPending} onClick={() => resolve.mutate({ approvalId: approval.id, decision: "yes" })}>
          Yes
        </Button>
      </div>
      {resolve.isError && <p className="text-xs text-red-500">{resolve.error.message}</p>}
    </CardShell>
  );
}
