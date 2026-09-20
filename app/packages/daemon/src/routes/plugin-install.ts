import type { FastifyInstance } from "fastify";
import { CLI_NAMES, installPlugin, resolveCliPath, type Cli } from "@crewbench/adapters";
import { ApiInstallPluginResponseSchema } from "@crewbench/contract";

/** `POST /api/plugin-install/:cli` (Phase 4 milestone 2) -- runs the
 * real, per-CLI plugin-install command sequence (`@crewbench/adapters`'
 * `installPlugin()`, whose own docstring has the full per-CLI story).
 * No project/task association -- this installs crewbench itself into a
 * CLI's own plugin system, a machine-wide action, not a per-project one. */
export function registerPluginInstallRoutes(app: FastifyInstance): void {
  app.post<{ Params: { cli: string } }>("/api/plugin-install/:cli", async (request, reply) => {
    const cli = request.params.cli;
    if (!(CLI_NAMES as readonly string[]).includes(cli)) {
      await reply.code(400).send({ error: `unknown cli: ${cli}` });
      return;
    }
    const cliPath = resolveCliPath(cli as Cli);
    if (!cliPath) {
      await reply.code(400).send({ error: `${cli} was not found on PATH -- install it first` });
      return;
    }
    const result = await installPlugin(cli as Cli, cliPath);
    await reply.send(ApiInstallPluginResponseSchema.parse({ cli, ...result }));
  });
}
