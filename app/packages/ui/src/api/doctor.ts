import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiDoctorResponse, ApiProjectUsageRow } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

export function useDoctor() {
  return useQuery({
    queryKey: ["doctor"],
    queryFn: () => apiFetch<ApiDoctorResponse>("/api/doctor"),
  });
}

export function useRefreshDoctor() {
  const queryClient = useQueryClient();
  return async () => {
    await apiFetch<ApiDoctorResponse>("/api/doctor?refresh=1");
    await queryClient.invalidateQueries({ queryKey: ["doctor"] });
  };
}

export function useProjectUsage(projectId: string | undefined) {
  return useQuery({
    queryKey: ["projects", projectId, "usage"],
    queryFn: () => apiFetch<ApiProjectUsageRow[]>(`/api/projects/${projectId}/usage`),
    enabled: Boolean(projectId),
  });
}
