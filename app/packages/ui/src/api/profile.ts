import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@crewbench/contract";
import { ApiError, apiFetch } from "../lib/api.js";

/** `GET /api/projects/:pid/profile` 404s when no profile has been
 * confirmed yet (`routes/profile.ts`) -- a normal, expected state here
 * (every project starts this way), not an error condition the UI should
 * surface as one. Resolves to `null` in that one specific case; any
 * other failure still rejects normally. */
export function useProfile(projectId: string | undefined) {
  return useQuery({
    queryKey: ["projects", projectId, "profile"],
    queryFn: async () => {
      try {
        return await apiFetch<Project>(`/api/projects/${projectId}/profile`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: Boolean(projectId),
  });
}

/** A fresh, *unsaved* detection (`?refresh=1`) -- not a `useQuery` of its
 * own (there's nothing to cache; each call re-runs real file-system
 * detection against the project's current files), a one-shot fetch the
 * caller seeds its own editable draft state from, mirroring
 * `useRefreshDoctor()`'s shape but returning the fresh value directly
 * instead of only invalidating a cache. */
export function useDetectProfile(projectId: string | undefined) {
  return useMutation({
    mutationFn: () => apiFetch<Project>(`/api/projects/${projectId}/profile?refresh=1`),
  });
}

export function useSaveProfile(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: Project) =>
      apiFetch<Project>(`/api/projects/${projectId}/profile`, { method: "PUT", body: JSON.stringify(profile) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "profile"] }).catch(() => {});
    },
  });
}
