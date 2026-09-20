import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { atomicWriteJson, detectProfile, nowIso, readJsonOrDefault } from "@crewbench/engine";
import { ProjectSchema } from "@crewbench/contract";
import { getProject } from "../registry.js";

function profilePath(projectPath: string): string {
  return join(projectPath, ".crewbench", "project.json");
}

/** `GET/PUT /api/projects/:pid/profile` (Phase 3 milestone 4, Design
 * decision 6) -- validates directly against `@crewbench/contract`'s
 * `ProjectSchema`. Mirrors `packages/cli`'s `profile show`/`refresh`
 * (`commands/profile.ts`) and `packages/engine`'s `detectProfile()`
 * (never writes anything itself -- the caller shows the proposal and
 * only saves it on confirmation, per that function's own docstring): a
 * plain `GET` reads the saved `.crewbench/project.json` (404 if none
 * exists yet -- unlike `.../team`, there is genuinely nothing to show,
 * matching `profile show`'s own "No .crewbench/project.json yet"
 * message), `GET ?refresh=1` runs a fresh, *unsaved* detection instead
 * (same `?refresh=1` convention `routes/doctor.ts` already uses), and
 * `PUT` is the "confirm" step -- it requires `confirmed: true` in the
 * body, enforcing `ProjectSchema`'s own doc comment ("Never write
 * project.json before this is true") server-side, not just by UI
 * convention. */
export function registerProfileRoutes(app: FastifyInstance): void {
  app.get<{ Params: { pid: string }; Querystring: { refresh?: string } }>("/api/projects/:pid/profile", async (request, reply) => {
    const project = await getProject(request.params.pid);
    if (!project) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    if (request.query.refresh === "1") {
      const detected = await detectProfile(project.path);
      await reply.send(ProjectSchema.parse(detected));
      return;
    }
    const path = profilePath(project.path);
    if (!existsSync(path)) {
      await reply.code(404).send({ error: "no project profile yet -- GET with ?refresh=1 to detect one" });
      return;
    }
    const profile = await readJsonOrDefault<unknown>(path, null);
    await reply.send(ProjectSchema.parse(profile));
  });

  app.put<{ Params: { pid: string }; Body: unknown }>("/api/projects/:pid/profile", async (request, reply) => {
    const project = await getProject(request.params.pid);
    if (!project) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    const parsed = ProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    if (!parsed.data.confirmed) {
      await reply.code(400).send({ error: "confirmed must be true -- a project profile is only ever saved once the user has confirmed it" });
      return;
    }
    const profile = { ...parsed.data, detected_at: parsed.data.detected_at ?? nowIso() };
    await atomicWriteJson(profilePath(project.path), profile);
    await reply.send(profile);
  });
}
