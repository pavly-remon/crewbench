import type { FastifyInstance } from "fastify";
import { listTasks } from "@crewbench/engine";
import { ApiProjectListSchema, ApiTaskListSchema, type ApiProject, type ApiTaskSummary } from "@crewbench/contract";
import { addProject, getProject, loadRegistry, NotAGitRepoError, removeProject } from "../registry.js";
import { join } from "node:path";

const ACTIVE_PHASES = new Set(["scoping", "design", "implementing", "verifying", "fixing", "awaiting_commit"]);
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function projectSummary(id: string, path: string, name: string, addedAt: string): Promise<ApiProject> {
  const rows = await listTasks(join(path, ".crewbench"));
  const now = Date.now();
  let active = 0;
  let recent = 0;
  for (const row of rows) {
    if (row.phase && ACTIVE_PHASES.has(row.phase)) active++;
    const updated = row.updated_at ? Date.parse(row.updated_at) : NaN;
    if (!Number.isNaN(updated) && now - updated <= RECENT_WINDOW_MS) recent++;
  }
  return { id, path, name, added_at: addedAt, active_task_count: active, recent_task_count: recent };
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/projects", async (_request, reply) => {
    const registry = await loadRegistry();
    const projects = await Promise.all(
      Object.values(registry).map((p) => projectSummary(p.id, p.path, p.name, p.added_at)),
    );
    const body = ApiProjectListSchema.parse(projects);
    await reply.send(body);
  });

  app.post<{ Body: { path: string; name?: string } }>("/api/projects", async (request, reply) => {
    const { path, name } = request.body ?? {};
    if (!path || typeof path !== "string") {
      await reply.code(400).send({ error: "path is required" });
      return;
    }
    try {
      const entry = await addProject(path, name);
      const body = ApiProjectListSchema.element.parse(await projectSummary(entry.id, entry.path, entry.name, entry.added_at));
      await reply.code(201).send(body);
    } catch (err) {
      if (err instanceof NotAGitRepoError) {
        await reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { pid: string } }>("/api/projects/:pid", async (request, reply) => {
    const removed = await removeProject(request.params.pid);
    if (!removed) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    await reply.code(204).send();
  });

  app.get<{ Params: { pid: string } }>("/api/projects/:pid/tasks", async (request, reply) => {
    const project = await getProject(request.params.pid);
    if (!project) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    const rows = await listTasks(join(project.path, ".crewbench"));
    const body: ApiTaskSummary[] = ApiTaskListSchema.parse(rows);
    await reply.send(body);
  });
}
