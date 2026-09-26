import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiCleanupCandidate } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

/** The new task-directory cleanup mechanism. `enabled` lets the caller
 * only fetch candidates once the cleanup dialog is actually open --
 * mirrors `useBrowseDirectory()`'s own established fix for the same
 * class of bug (a dialog's own query hook still runs even while the
 * dialog is visually closed, since React calls a mounted component's
 * hooks regardless of a child Radix `Dialog`'s own `open` prop; caught
 * live in this codebase's folder-browser dialog, same fix applied here
 * from the start rather than re-discovering it). */
export function useCleanupCandidates(projectId: string | undefined, olderThanDays: number, enabled: boolean) {
  return useQuery({
    queryKey: ["projects", projectId, "cleanup-candidates", olderThanDays],
    queryFn: () => apiFetch<ApiCleanupCandidate[]>(`/api/projects/${projectId}/tasks/cleanup-candidates?older_than_days=${olderThanDays}`),
    enabled: enabled && Boolean(projectId),
  });
}

export function useDeleteTask(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => apiFetch<{ deleted: string }>(`/api/tasks/${taskId}/delete`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "tasks"] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "cleanup-candidates"] }).catch(() => {});
    },
  });
}
