import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openEventStream } from "../lib/api.js";

interface GlobalEventPayload {
  id: string;
  projectId: string;
  taskId: string;
  event: { type: string; run: string | null };
}

/** Subscribes to the daemon's global board feed (`GET /api/events`,
 * Phase 2 milestone 2) for as long as the calling component is mounted,
 * and invalidates the affected project's task-list query on every
 * event -- "live" here means "refetch on signal," not a hand-maintained
 * client-side cache patch, which keeps the board's data path identical
 * whether it just loaded or just got a push (one code path, not two that
 * could drift). Reconnects with the last event id it saw, via the
 * `EventSource`-equivalent's own reconnect-on-error behavior in a later
 * milestone -- Phase 2 milestone 3's scope is the live board itself, not
 * reconnect/backoff polish.
 *
 * Also tracks which tasks currently have a queued run (Phase 3
 * milestone 2's Design decision 7: `run.queued`/`run.dequeued` are in
 * this same global allowlist) -- a task id enters the returned set on
 * `run.queued` and leaves it on `run.dequeued`/`run.started`/
 * `run.finished` for that same run, so a task waiting for a CLI slot to
 * free shows that state on the board, not just once it's already
 * running. */
export function useGlobalEvents(): Set<string> {
  const queryClient = useQueryClient();
  const projectIdsRef = useRef(new Set<string>());
  const [queuedTaskIds, setQueuedTaskIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = openEventStream("/api/events", (_id, data) => {
      const payload = data as GlobalEventPayload;
      if (!payload?.projectId) return;
      projectIdsRef.current.add(payload.projectId);
      queryClient.invalidateQueries({ queryKey: ["projects", payload.projectId, "tasks"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["projects"] }).catch(() => {});

      if (payload.event.type === "run.queued") {
        setQueuedTaskIds((prev) => new Set(prev).add(payload.taskId));
      } else if (["run.dequeued", "run.started", "run.finished"].includes(payload.event.type)) {
        setQueuedTaskIds((prev) => {
          if (!prev.has(payload.taskId)) return prev;
          const next = new Set(prev);
          next.delete(payload.taskId);
          return next;
        });
      }
    });
    return () => controller.abort();
  }, [queryClient]);

  return queuedTaskIds;
}
