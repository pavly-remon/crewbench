import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";

/** `GET /api/capabilities` (Phase 4 milestone 3) -- gates the "Open
 * session" embedded-terminal button entirely. `staleTime: Infinity`: a
 * daemon process's own pty capability can't change mid-process (it's
 * detected once, cached, at startup -- `pty-capability.ts`), so refetching
 * this on every task-detail visit would be pure waste. */
export function useCapabilities() {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: () => apiFetch<{ pty: boolean }>("/api/capabilities"),
    staleTime: Infinity,
  });
}
