import { useEffect, useState } from "react";
import { getToken } from "../lib/auth.js";

// Same-origin unconditionally -- see lib/api.ts's own API_BASE docstring
// for why (vite.config.ts's dev-server proxy makes this correct under
// `vite dev` too, not just in the packaged daemon-served build).
const API_BASE: string = window.location.origin;

/** Fetches one screenshot with the bearer token attached and hands back
 * a local object URL -- a plain `<img src="/api/...">` can't attach the
 * `Authorization` header the route requires (same constraint
 * `lib/api.ts`'s `openEventStream` already worked around for SSE), so
 * this fetches the bytes via JS and lets the browser own a blob: URL
 * instead. Revokes it on unmount/path change so repeated navigation
 * doesn't leak object URLs. */
function useAuthedImage(path: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      const token = getToken();
      const headers = new Headers();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const res = await fetch(`${API_BASE}${path}`, { headers });
      if (!res.ok || cancelled) return;
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      if (!cancelled) setUrl(objectUrl);
    })().catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return url;
}

function Screenshot({ taskId, file }: { taskId: string; file: string }) {
  const url = useAuthedImage(`/api/tasks/${taskId}/screenshots/${file}`);
  return (
    <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
      {url ? <img src={url} alt={file} className="w-full" /> : <div className="h-40 animate-pulse bg-[var(--color-bg-subtle)]" />}
      <p className="p-1.5 text-xs text-[var(--color-fg-muted)]">{file}</p>
    </div>
  );
}

export function ScreenshotsTab({ taskId, screenshots }: { taskId: string; screenshots: string[] }) {
  if (screenshots.length === 0) {
    return <p className="text-sm text-[var(--color-fg-muted)]">No visual-check screenshots for this task.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {screenshots.map((path) => (
        <Screenshot key={path} taskId={taskId} file={path.split("/").pop() ?? path} />
      ))}
    </div>
  );
}
