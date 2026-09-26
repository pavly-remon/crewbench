import type { FastifyInstance } from "fastify";
import { ApiUpdateCheckResponseSchema } from "@crewbench/contract";
import { checkForUpdate } from "../update-check.js";

/** `GET /api/update-check` (Phase 4 milestone 5, Design decision 7) --
 * thin wrapper around `update-check.ts`'s own real, cached registry
 * call. Never blocks startup or any other route -- the UI polls this on
 * its own schedule for a purely informational banner. */
export function registerUpdateCheckRoutes(app: FastifyInstance): void {
  app.get("/api/update-check", async (_request, reply) => {
    const result = await checkForUpdate();
    await reply.send(ApiUpdateCheckResponseSchema.parse(result));
  });
}
