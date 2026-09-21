import { useQuery } from "@tanstack/react-query";
import type { ApiUpdateCheckResponse } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

/** Phase 4 milestone 5, Design decision 7: polled on the UI's own
 * schedule (`refetchInterval`, well under the daemon's own 24h cache TTL
 * -- polling more often than the cache changes just means most polls are
 * free, served from the daemon's in-memory cache, not that this hits the
 * real npm registry more often), purely informational. No auto-update
 * action anywhere in this hook or its caller. */
export function useUpdateCheck() {
  return useQuery({
    queryKey: ["update-check"],
    queryFn: () => apiFetch<ApiUpdateCheckResponse>("/api/update-check"),
    refetchInterval: 60 * 60 * 1000, // 1h -- the daemon's own cache means this is cheap
    staleTime: 60 * 60 * 1000,
  });
}
