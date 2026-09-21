import type { FastifyInstance } from "fastify";
import { DaemonConfigSchema } from "@crewbench/contract";
import { loadConfig, saveConfig } from "../config.js";

/** `GET/PUT /api/config` (Phase 4 milestone 4, Design decision 5) --
 * `~/.crewbench/config.json`, the same envelope/validation pattern Phase
 * 3's `routes/team.ts`/`routes/profile.ts` already established: `GET`
 * returns `{}` when the file doesn't exist yet (a real, meaningful state
 * -- every field simply falls back to its own built-in default, same as
 * `team.json` not existing means "use the hardcoded lineup defaults"),
 * `PUT` validates and writes the whole object. See `config.ts`'s own
 * `saveConfig()` docstring for why `port`/`concurrency` changes here
 * only take effect on the daemon's *next* start, not this one. */
export function registerConfigRoutes(app: FastifyInstance): void {
  app.get("/api/config", async (_request, reply) => {
    const config = await loadConfig();
    await reply.send(DaemonConfigSchema.parse(config));
  });

  app.put<{ Body: unknown }>("/api/config", async (request, reply) => {
    const parsed = DaemonConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    await saveConfig(parsed.data);
    await reply.send(parsed.data);
  });
}
