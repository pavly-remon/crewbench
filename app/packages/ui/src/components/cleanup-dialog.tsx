import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { ApiCleanupCandidate } from "@crewbench/contract";
import { Dialog } from "./dialog.js";
import { Button } from "./button.js";
import { useCleanupCandidates, useDeleteTask } from "../api/task-cleanup.js";

const DEFAULT_OLDER_THAN_DAYS = 30;

function CandidateRow({ projectId, candidate }: { projectId: string; candidate: ApiCleanupCandidate }) {
  const [confirming, setConfirming] = useState(false);
  const del = useDeleteTask(projectId);

  if (del.isSuccess) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] p-2 text-sm text-[var(--color-fg-muted)]">
        Deleted {candidate.title ?? candidate.id}.
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] p-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{candidate.title ?? candidate.id}</p>
        <p className="text-xs text-[var(--color-fg-muted)]">
          {candidate.phase} · {candidate.age_days === null ? "no recorded activity date" : `${candidate.age_days} days old`}
        </p>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => setConfirming(false)} disabled={del.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => del.mutate(candidate.id)} disabled={del.isPending}>
            {del.isPending ? "Deleting…" : "Confirm delete"}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setConfirming(true)} className="shrink-0">
          <Trash2 size={14} className="mr-1.5" />
          Delete
        </Button>
      )}
      {del.isError && <p className="text-xs text-red-500">{del.error.message}</p>}
    </div>
  );
}

/** Lists finished tasks (done/stopped/failed) past an age threshold and
 * deletes each only on explicit, per-task confirmation -- there is no
 * bulk delete and nothing here ever runs automatically, matching the
 * plugin side's own `/crewbench:status --cleanup` precedent exactly.
 * Deleting a task removes its entire on-disk directory (every round's
 * logs/results/events.jsonl/state.json) and its index.json entry; there
 * is no undo, which is why each row gets its own explicit confirm step
 * rather than a single dialog-level "delete all" action. */
export function CleanupDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [olderThanDays, setOlderThanDays] = useState(DEFAULT_OLDER_THAN_DAYS);
  const { data: candidates, isLoading, isError, error } = useCleanupCandidates(projectId, olderThanDays, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Clean up old tasks" widthClassName="max-w-lg">
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          Finished tasks older than
          <input
            type="number"
            min={0}
            value={olderThanDays}
            onChange={(e) => setOlderThanDays(Math.max(0, Number(e.target.value) || 0))}
            className="w-16 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
          />
          days
        </label>

        <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
          {isLoading && <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>}
          {isError && <p className="text-sm text-red-500">{error.message}</p>}
          {!isLoading && !isError && candidates?.length === 0 && (
            <p className="text-sm text-[var(--color-fg-muted)]">No finished tasks are that old yet.</p>
          )}
          {candidates?.map((c) => <CandidateRow key={c.id} projectId={projectId} candidate={c} />)}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
