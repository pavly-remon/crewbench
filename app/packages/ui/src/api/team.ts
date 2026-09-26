import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Team } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

export function useTeam(projectId: string | undefined) {
  return useQuery({
    queryKey: ["projects", projectId, "team"],
    queryFn: () => apiFetch<Team>(`/api/projects/${projectId}/team`),
    enabled: Boolean(projectId),
  });
}

export function useSaveTeam(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (team: Team) => apiFetch<Team>(`/api/projects/${projectId}/team`, { method: "PUT", body: JSON.stringify(team) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "team"] }).catch(() => {});
    },
  });
}
