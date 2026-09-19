import { getToken } from "./auth.js";

/** Same-origin by default (the packaged daemon serves this build itself,
 * per docs/app/CONTEXT.md's daemon description) -- `VITE_API_BASE`
 * overrides it for `vite dev`, where the UI's own dev server runs on a
 * different port than `crewbench ui`'s daemon. */
const API_BASE: string = import.meta.env.VITE_API_BASE ?? window.location.origin;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** An `EventSource`-equivalent that can send a bearer token -- the native
 * `EventSource` constructor has no way to set custom request headers, so
 * a fetch-based reader is used instead (docs/app/phase-2-plan.md's
 * milestone 3 note flagging this as a decision to make here rather than
 * guess earlier). Calls `onEvent` for every `data:` line's parsed JSON,
 * reconnecting is the caller's responsibility (React Query's own
 * subscription lifecycle drives that in practice -- see
 * `useTaskEvents`/`useGlobalEvents`). Returns an `AbortController` to
 * stop the stream. */
export function openEventStream(path: string, onEvent: (id: string | null, data: unknown) => void): AbortController {
  const controller = new AbortController();
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  (async () => {
    try {
      const res = await fetch(`${API_BASE}${path}`, { headers, signal: controller.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const parts = buffered.split("\n\n");
        buffered = parts.pop() ?? "";
        for (const part of parts) {
          let id: string | null = null;
          let data: string | null = null;
          for (const line of part.split("\n")) {
            if (line.startsWith("id: ")) id = line.slice(4);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (data !== null) {
            try {
              onEvent(id, JSON.parse(data));
            } catch {
              // malformed line -- skip rather than crash the stream reader
            }
          }
        }
      }
    } catch {
      // aborted, or the connection dropped -- caller decides whether to reconnect
    }
  })();

  return controller;
}
