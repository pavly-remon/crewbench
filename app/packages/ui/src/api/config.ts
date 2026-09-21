import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonConfig } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => apiFetch<DaemonConfig>("/api/config"),
  });
}

export function useSaveConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: DaemonConfig) => apiFetch<DaemonConfig>("/api/config", { method: "PUT", body: JSON.stringify(config) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] }).catch(() => {});
    },
  });
}
