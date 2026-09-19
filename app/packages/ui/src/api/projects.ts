import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiProject, ApiTaskSummary } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => apiFetch<ApiProject[]>("/api/projects"),
  });
}

export function useProjectTasks(projectId: string | undefined) {
  return useQuery({
    queryKey: ["projects", projectId, "tasks"],
    queryFn: () => apiFetch<ApiTaskSummary[]>(`/api/projects/${projectId}/tasks`),
    enabled: Boolean(projectId),
  });
}

export function useAddProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; name?: string | undefined }) =>
      apiFetch<ApiProject>("/api/projects", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] }).catch(() => {});
    },
  });
}

export function useRemoveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => apiFetch<void>(`/api/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] }).catch(() => {});
    },
  });
}
