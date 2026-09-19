import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { openEventStream } from "../lib/api.js";

interface GlobalEventPayload {
  id: string;
  projectId: string;
  taskId: string;
  event: { type: string };
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
 * reconnect/backoff polish. */
export function useGlobalEvents(): void {
  const queryClient = useQueryClient();
  const projectIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const controller = openEventStream("/api/events", (_id, data) => {
      const payload = data as GlobalEventPayload;
      if (!payload?.projectId) return;
      projectIdsRef.current.add(payload.projectId);
      queryClient.invalidateQueries({ queryKey: ["projects", payload.projectId, "tasks"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["projects"] }).catch(() => {});
    });
    return () => controller.abort();
  }, [queryClient]);
}
