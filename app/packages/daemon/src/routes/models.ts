import type { FastifyInstance } from "fastify";
import { CLI_NAMES, listAvailableModels, resolveCliPath, type Cli } from "@crewbench/adapters";
import { ApiAvailableModelsSchema } from "@crewbench/contract";

/** `GET /api/models/:cli` -- the lineup/team editors' model dropdown
 * (never asked for by any earlier phase plan; added directly for the
 * model-picker UI request). Never 400s on a CLI with no listing
 * capability -- `checked: false` is a normal, expected response for
 * three of the four CLIs today (see `@crewbench/adapters`'
 * `listAvailableModels()`'s own docstring for which, and why, re-verified
 * against the real installed binaries before this route was written),
 * not an error condition the client needs to branch on separately from
 * "CLI not installed" (`resolveCliPath` returning `null` gets the same
 * shape, just with its own `error` message). */
export function registerModelRoutes(app: FastifyInstance): void {
  app.get<{ Params: { cli: string } }>("/api/models/:cli", async (request, reply) => {
    const cli = request.params.cli;
    if (!(CLI_NAMES as readonly string[]).includes(cli)) {
      await reply.code(400).send({ error: `unknown cli: ${cli}` });
      return;
    }
    const cliPath = resolveCliPath(cli as Cli);
    if (!cliPath) {
      await reply.send(
        ApiAvailableModelsSchema.parse({ cli, checked: false, available: [], error: `${cli} was not found on PATH` }),
      );
      return;
    }
    const result = await listAvailableModels(cli as Cli, cliPath);
    await reply.send(ApiAvailableModelsSchema.parse({ cli, ...result }));
  });
}
