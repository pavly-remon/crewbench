/** Reads the daemon's bearer token from `location.hash` exactly once
 * (docs/app/phase-2-plan.md's Design decision 7: a URL fragment, not a
 * query param, so it's never sent to the server or logged in access
 * logs/history), strips it from the visible URL immediately via
 * `history.replaceState`, and holds it in memory for the rest of this
 * page's life -- never `localStorage` (the token is scoped to one daemon
 * process's lifetime; persisting it would let a stale token outlive a
 * restart and silently fail every request instead of prompting a fresh
 * `crewbench ui`). */
let cachedToken: string | null = null;

export function bootstrapToken(): string | null {
  if (cachedToken) return cachedToken;
  const hash = window.location.hash;
  const match = /(?:^#|&)token=([^&]+)/.exec(hash);
  if (!match) return null;
  cachedToken = decodeURIComponent(match[1] ?? "");
  const rest = hash.replace(/(?:^#|&)token=[^&]+/, "").replace(/^#&/, "#");
  const url = new URL(window.location.href);
  url.hash = rest === "#" ? "" : rest;
  window.history.replaceState(null, "", url.toString());
  return cachedToken;
}

export function getToken(): string | null {
  return cachedToken;
}
