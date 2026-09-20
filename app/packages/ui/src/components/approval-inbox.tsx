import { useState } from "react";
import { Bell } from "lucide-react";
import { useApprovalsInbox } from "../api/approvals.js";
import { useApprovalNotifications } from "../lib/notifications.js";
import { ApprovalCard } from "./approval-card.js";
import { Button } from "./button.js";

/** The global "needs you" inbox (Phase 3 milestone 5): a badge on a bell
 * button in the app header, opening a panel of every pending approval
 * across every project this daemon is driving (`GET /api/approvals`).
 * Mounted once, in `Layout`, so it's visible from anywhere in the app --
 * not per-project or per-task, matching the phase prompt's own "global"
 * wording. Also owns the desktop-notification opt-in toggle (Design
 * decision 8): notifications are a property of this same pending list,
 * not a separate subsystem. */
export function ApprovalInbox() {
  const { data: pending } = useApprovalsInbox();
  const notifications = useApprovalNotifications(pending);
  const [open, setOpen] = useState(false);
  const count = pending?.length ?? 0;

  return (
    <div className="relative">
      <button
        aria-label={`${count} approvals need you`}
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-accent)] text-[10px] text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-full right-0 z-10 mt-2 flex max-h-[70vh] w-96 flex-col gap-3 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 shadow-lg">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Needs you</h2>
            <button className="text-xs text-[var(--color-fg-muted)] hover:underline" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>

          {notifications.supported && notifications.permission !== "granted" && (
            <Button variant="secondary" onClick={() => void notifications.requestOptIn()} className="justify-start text-xs">
              Enable desktop notifications
            </Button>
          )}

          {count === 0 && <p className="text-sm text-[var(--color-fg-muted)]">Nothing needs you right now.</p>}

          {pending?.map((approval) => <ApprovalCard key={approval.id} approval={approval} />)}
        </div>
      )}
    </div>
  );
}
