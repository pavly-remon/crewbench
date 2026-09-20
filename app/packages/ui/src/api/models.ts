import { useQuery } from "@tanstack/react-query";
import type { ApiAvailableModels, ApiCli } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

/** The lineup/team editors' model dropdown. `enabled` lets a caller skip
 * fetching for a CLI it isn't currently showing (`role-lineup-editor.tsx`
 * only wants this for whichever CLI a role row currently has selected,
 * not all four up front) -- `staleTime` is generous since a CLI's own
 * model list doesn't change within one browser session. */
export function useAvailableModels(cli: ApiCli, enabled: boolean) {
  return useQuery({
    queryKey: ["models", cli],
    queryFn: () => apiFetch<ApiAvailableModels>(`/api/models/${cli}`),
    enabled,
    staleTime: 5 * 60_000,
  });
}
