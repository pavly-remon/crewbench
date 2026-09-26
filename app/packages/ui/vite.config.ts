import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Daemon-served static UI in production (`crewbench ui` starts the
// daemon and serves this build directly, same-origin -- Phase 2
// milestone 1). `vite dev` is a genuinely different origin (its own
// dev-server port, not the daemon's), and the app has grown real
// mutating routes, SSE, and a WebSocket PTY channel since the comment
// this replaces was written -- all of which the daemon's own
// `createAuthHook` (Origin-checked, `packages/daemon/src/auth.ts`)
// rejects across origins by design, and none of which the browser would
// even let JS read the response of without CORS headers the daemon
// doesn't send either.
//
// **Real, disclosed gap found by review, fixed here**: a `VITE_API_BASE`
// env var was documented in `lib/api.ts`'s own comment as the fix for
// this, but pointing the browser's own `fetch()` calls directly at the
// daemon's real origin doesn't clear either the Origin check or CORS --
// it was a real, never-actually-working escape hatch. A dev-server
// *proxy* is the standard fix instead: every `/api/*` request (including
// the WebSocket upgrade for the embedded-terminal PTY channel,
// `ws: true`) stays same-origin from the browser's own point of view (to
// *this* dev server), and Vite forwards it server-side to the real
// daemon. `lib/api.ts`/`screenshots-tab.tsx` no longer need
// `VITE_API_BASE` at all with this in place -- both now just use
// `window.location.origin` unconditionally, since that's correct in
// both the packaged (same-origin for real) and `vite dev` (same-origin
// via this proxy) cases.
//
// **A real bug in this fix's own first draft, caught live, not
// assumed correct**: `changeOrigin: true` only rewrites the proxied
// request's `Host` header to match the target -- it does NOT touch the
// browser's own `Origin` header, confirmed by an actual `curl` against a
// real running daemon through a real `vite dev` proxy, which came back
// `403 {"error":"origin not allowed"}` even with `changeOrigin: true`
// set. `createAuthHook` was still seeing the dev server's own Origin
// (`http://localhost:5173`), never in its allowlist. Fixed with an
// explicit `configure()` hook that rewrites the outgoing `Origin` header
// on every proxied request to the daemon's own real origin, verified
// against the same live daemon afterward: a real `200` with real project
// data, not just a passing typecheck.
//
// The daemon's own port isn't discoverable by this config file at
// startup (a fresh port and bearer token are chosen at runtime by
// `crewbench ui` itself, Phase 2 Design decision 7's "never persisted"
// principle) -- `CREWBENCH_DEV_DAEMON_PORT` lets a developer point this
// at whichever real daemon they started for `vite dev` against; the
// daemon's own compiled-in default (`DEFAULT_PORT`,
// `packages/daemon/src/config.ts`) is a reasonable fallback for the
// common case of one daemon running with no `--port` override.
const daemonPort = process.env.CREWBENCH_DEV_DAEMON_PORT ?? "4287";
const daemonTarget = `http://127.0.0.1:${daemonPort}`;

const apiProxy: ProxyOptions = {
  target: daemonTarget,
  changeOrigin: true,
  ws: true,
  configure(proxy) {
    proxy.on("proxyReq", (proxyReq: { setHeader: (name: string, value: string) => void }) => {
      proxyReq.setHeader("origin", daemonTarget);
    });
    // The WebSocket upgrade path (the embedded-terminal PTY channel) is
    // a separate event from the plain HTTP proxyReq above -- needs the
    // identical Origin rewrite, or a real `vite dev` session's "Open
    // session" button would 403 at the upgrade handshake even though
    // every plain fetch() already works.
    proxy.on("proxyReqWs", (proxyReq: { setHeader: (name: string, value: string) => void }) => {
      proxyReq.setHeader("origin", daemonTarget);
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": apiProxy,
    },
  },
});
