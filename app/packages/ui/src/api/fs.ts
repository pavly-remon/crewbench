import { useQuery } from "@tanstack/react-query";
import type { ApiFsBrowseResponse } from "@crewbench/contract";
import { apiFetch } from "../lib/api.js";

/** The "Add project" dialog's directory browser. `path: null` means "the
 * daemon's default starting directory" (its own home dir -- see
 * `routes/fs-browse.ts`'s docstring), not "no request yet" -- within an
 * open dialog, the query is enabled the moment it opens, before the
 * user has navigated anywhere. `enabled` is a real, separate flag, not
 * derived from `path`: `FolderBrowserDialog` is mounted (and its query
 * hook called, since React calls a component's hooks regardless of
 * whatever a child Radix `Dialog`'s own `open` prop does internally)
 * even while its dialog is visually closed -- a real bug caught live by
 * `projects-page.test.tsx`'s existing test, which crashed on an
 * unexpected `/api/fs/browse` fetch firing the moment the *page*
 * mounted, not when anyone actually opened the folder picker. */
export function useBrowseDirectory(path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["fs-browse", path],
    queryFn: () => apiFetch<ApiFsBrowseResponse>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
    enabled,
  });
}
