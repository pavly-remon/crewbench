import type { FastifyInstance } from "fastify";
import { CLI_NAMES, createAdapter } from "@crewbench/adapters";
import { ApiDoctorResponseSchema, type ApiDoctorResponse } from "@crewbench/contract";
import { nowIso } from "@crewbench/engine";

const CACHE_TTL_MS = 60_000;

/** `GET /api/doctor?refresh=1` -- each adapter's `doctor()` makes real
 * network/auth calls (Phase 0/1's adapters, unchanged here), so this is
 * cached for `CACHE_TTL_MS` and only re-run early when the caller
 * explicitly asks, per the phase prompt's own "(cached)" note and the
 * Health page's "exact fix hint... with a manual refresh button." The
 * cache lives in this closure, one per `registerDoctorRoutes()` call
 * (one per daemon instance) -- deliberately not module-level, since
 * several daemon instances legitimately run in the same process across
 * this package's own test suite, and a shared global cache would leak
 * one instance's result into another's response. */
export function registerDoctorRoutes(app: FastifyInstance): void {
  let cached: ApiDoctorResponse | null = null;
  let cachedAt = 0;

  app.get<{ Querystring: { refresh?: string } }>("/api/doctor", async (request, reply) => {
    const forceRefresh = request.query.refresh === "1";
    const stale = Date.now() - cachedAt > CACHE_TTL_MS;
    if (!cached || stale || forceRefresh) {
      const reports = await Promise.all(CLI_NAMES.map((cli) => createAdapter(cli).doctor()));
      cached = { reports, checked_at: nowIso() };
      cachedAt = Date.now();
    }
    await reply.send(ApiDoctorResponseSchema.parse(cached));
  });
}
