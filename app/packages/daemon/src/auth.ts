import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A fresh, process-lifetime-only bearer token -- never persisted, never
 * sent anywhere but into the browser URL the daemon itself opens
 * (docs/app/phase-2-plan.md's Design decision 7). 32 random bytes,
 * hex-encoded: long enough that guessing it isn't a realistic attack on a
 * loopback-only server, short enough to fit comfortably in a URL
 * fragment. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Rejects any request that doesn't present exactly this token as
 * `Authorization: Bearer <token>`, and any request whose `Origin` header
 * isn't this daemon's own loopback origin -- both checks are named as
 * non-negotiable in the Phase 2 prompt ("Reject requests without it.
 * Check the Origin header."). The Origin check only applies when the
 * header is present at all: a same-origin XHR/fetch always sends it, a
 * plain top-level navigation and most non-browser HTTP clients (curl,
 * the daemon's own healthcheck) don't -- so its absence is not itself
 * treated as suspicious, only a *wrong* value is. */
/** Constant-time comparison -- guards against a timing side-channel
 * revealing the token byte-by-byte. Low-stakes for a loopback-only
 * server, but cheap to do right. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuthHook(token: string, port: number) {
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Static UI assets (index.html, JS, CSS) are deliberately exempt: the
    // browser's own <script>/<link> requests for them never carry the
    // Authorization header, and the page has to load *before* its own JS
    // can read the token out of the URL fragment and start attaching it
    // to /api/* calls. None of those files contain the token or any
    // other secret -- it's generated fresh per daemon start and only
    // ever appears in the URL the daemon itself opens.
    if (!request.url.startsWith("/api/")) return;

    const auth = request.headers.authorization;
    const presented = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    if (!presented || !tokensMatch(presented, token)) {
      await reply.code(401).send({ error: "missing or invalid bearer token" });
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      await reply.code(403).send({ error: "origin not allowed" });
      return;
    }
  };
}
