import { getToken } from "./auth.js";

/** Always same-origin: the packaged daemon serves this build itself
 * directly (`crewbench ui`, Phase 2), and under `vite dev` the same is
 * true from the browser's own point of view too, now that
 * `vite.config.ts`'s own dev-server proxy forwards `/api/*` to the real
 * daemon -- see that file's own docstring for why a `VITE_API_BASE`
 * pointing straight at the daemon's real origin (this file's own
 * earlier approach) never actually worked: the daemon's Origin check
 * and missing CORS headers both reject a genuine cross-origin request
 * regardless of what URL the client itself points at. */
const API_BASE: string = window.location.origin;

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

/** The embedded-terminal PTY channel's own connection URL (Phase 4
 * milestone 3) -- a real `WebSocket`, which has no mechanism to set
 * custom request headers at all (unlike `apiFetch`/`openEventStream`
 * above, both real header-bearing `fetch()` calls) -- so the token
 * travels as `?token=`, a real, narrowly-scoped, disclosed exception
 * matched exactly on the daemon side (`auth.ts`'s own
 * `isPtyWebsocketPath()`, gated to this one path shape only). Same-origin
 * `API_BASE` swapped from `http(s)` to `ws(s)`, not hardcoded, so this
 * still works under `vite dev`'s own proxy (`vite.config.ts`, `ws: true`
 * on the same `/api` proxy entry `apiFetch()`/`openEventStream()` use). */
export function ptyWebSocketUrl(taskId: string): string {
  const token = getToken() ?? "";
  const wsBase = API_BASE.replace(/^http/, "ws");
  return `${wsBase}/api/tasks/${encodeURIComponent(taskId)}/pty?token=${encodeURIComponent(token)}`;
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
export function openEventStream(
  path: string,
  onEvent: (id: string | null, data: unknown) => void,
  init: { method?: "GET" | "POST"; body?: unknown; onDone?: () => void } = {},
): AbortController {
  const controller = new AbortController();
  const token = getToken();
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  (async () => {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        // A non-2xx (or bodyless) response means no stream ever opened --
        // still call onDone so a caller like useScopingChat's `sending`
        // flag doesn't stay stuck true forever (found live: the scoping
        // route can genuinely 500 before its SSE stream starts, e.g. a
        // filesystem write failing on the very first turn, before there's
        // any stream to report failure over).
        init.onDone?.();
        return;
      }
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
      init.onDone?.();
    } catch {
      // aborted, or the connection dropped -- caller decides whether to reconnect
    }
  })();

  return controller;
}
