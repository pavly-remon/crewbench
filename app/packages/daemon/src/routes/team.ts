import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { atomicWriteJson, readJsonOrDefault } from "@crewbench/engine";
import { TeamSchema } from "@crewbench/contract";
import { getProject } from "../registry.js";

function teamPath(projectPath: string): string {
  return join(projectPath, ".crewbench", "team.json");
}

/** `GET/PUT /api/projects/:pid/team` (Phase 3 milestone 4, Design
 * decision 6) -- validates directly against `@crewbench/contract`'s
 * `TeamSchema`, no new schema. `team.json` not existing yet is a normal,
 * meaningful state (every role/setting simply falls back to
 * `packages/cli`'s own hardcoded defaults, per `lineup.ts`'s
 * `resolveLineup()`) -- `GET` returns `{}` in that case rather than 404,
 * unlike `.../profile` below, where an unconfirmed profile is genuinely
 * "nothing to show yet." */
export function registerTeamRoutes(app: FastifyInstance): void {
  app.get<{ Params: { pid: string } }>("/api/projects/:pid/team", async (request, reply) => {
    const project = await getProject(request.params.pid);
    if (!project) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    const team = await readJsonOrDefault<unknown>(teamPath(project.path), {});
    await reply.send(TeamSchema.parse(team));
  });

  app.put<{ Params: { pid: string }; Body: unknown }>("/api/projects/:pid/team", async (request, reply) => {
    const project = await getProject(request.params.pid);
    if (!project) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    const parsed = TeamSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    await atomicWriteJson(teamPath(project.path), parsed.data);
    await reply.send(parsed.data);
  });
}
