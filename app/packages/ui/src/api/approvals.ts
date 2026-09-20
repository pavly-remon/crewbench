import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiPendingApproval } from "@crewbench/contract";
import { apiFetch, openEventStream } from "../lib/api.js";

interface GlobalEventPayload {
  event?: { type?: string };
}

/** The global "needs you" inbox (Phase 3 milestone 5) -- `GET
 * /api/approvals`, kept fresh by invalidating on the same `approval.*`
 * events `docs/app/contract/events.md` documents (Phase 2's global feed,
 * `GET /api/events`, already carries them per `watcher.ts`'s allowlist).
 * "Live" here means "refetch on signal," the same pattern
 * `useGlobalEvents()` already uses for the task board -- one data path
 * whether the panel just opened or just got a push. */
export function useApprovalsInbox() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["approvals"],
    queryFn: () => apiFetch<ApiPendingApproval[]>("/api/approvals"),
    refetchInterval: 30_000, // a light fallback in case an SSE reconnect is mid-flight -- the event listener below is the primary path
  });

  useEffect(() => {
    const controller = openEventStream("/api/events", (_id, data) => {
      const payload = data as GlobalEventPayload;
      if (payload.event?.type?.startsWith("approval.")) {
        queryClient.invalidateQueries({ queryKey: ["approvals"] }).catch(() => {});
      }
    });
    return () => controller.abort();
  }, [queryClient]);

  return query;
}

export function useResolveApproval(taskId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ approvalId, decision, data }: { approvalId: string; decision: "yes" | "no" | "custom"; data?: unknown }) =>
      apiFetch<{ ok: boolean }>(`/api/tasks/${taskId}/approvals/${approvalId}`, {
        method: "POST",
        body: JSON.stringify(data === undefined ? { decision } : { decision, data }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["tasks", taskId] }).catch(() => {});
    },
  });
}
