import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ApiTaskDetail } from "@crewbench/contract";
import { apiFetch, openEventStream } from "../lib/api.js";

export function useTaskDetail(taskId: string | undefined) {
  return useQuery({
    queryKey: ["tasks", taskId],
    queryFn: () => apiFetch<ApiTaskDetail>(`/api/tasks/${taskId}`),
    enabled: Boolean(taskId),
  });
}

interface TaskEventPayload {
  seq: number;
  ts: string;
  type: string;
  run: string | null;
  data: unknown;
}

/** Subscribes to one task's own SSE stream (`GET /api/tasks/:tid/events`,
 * Phase 2 milestone 2) for as long as the caller is mounted, invalidating
 * the task-detail query on every event so the header/rounds/lanes redraw
 * from a fresh `GET /api/tasks/:tid` -- same "refetch on signal" pattern
 * as the board's `useGlobalEvents` (milestone 3), for the same reason:
 * one data path for "just loaded" and "just got a push," not two that
 * could drift apart. `onEvent` additionally gets every raw event, for
 * the agent lanes to append to their own live log view without waiting
 * on a full task-detail refetch. */
export function useTaskEvents(taskId: string | undefined, onEvent?: (event: TaskEventPayload) => void): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!taskId) return;
    const controller = openEventStream(`/api/tasks/${taskId}/events`, (_id, data) => {
      const event = data as TaskEventPayload;
      onEvent?.(event);
      queryClient.invalidateQueries({ queryKey: ["tasks", taskId] }).catch(() => {});
    });
    return () => controller.abort();
    // Deliberately not depending on `onEvent`: callers pass an inline
    // closure per render, and resubscribing the SSE connection on every
    // render (instead of only when the task id changes) would reconnect
    // constantly. `onEvent` is only ever read from inside the live
    // callback above, never captured stale in a way that matters here.
  }, [taskId, queryClient]);
}
