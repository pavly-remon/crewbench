import type { FastifyInstance } from "fastify";
import { listTasks } from "@crewbench/engine";
import { ApiProjectListSchema, ApiTaskListSchema, type ApiProject, type ApiTaskSummary } from "@crewbench/contract";
import { addProject, getProject, loadRegistry, NotAGitRepoError, removeProject } from "../registry.js";
import type { DaemonWatcher } from "../watcher.js";
import type { TaskRunner } from "../task-runner.js";
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

export async function registerProjectRoutes(app: FastifyInstance, watcher: DaemonWatcher, taskRunner: TaskRunner): Promise<void> {
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
      await watcher.addProject(entry);
      // Covers a project with an in-flight app-owned task left behind by
      // a previous daemon instance that crashed (Phase 3 milestone 1) --
      // not just the common "already in the registry at startup" case
      // startDaemon() handles.
      await taskRunner.reattachProject(entry.path).catch((err: unknown) => {
        console.error(`failed to reattach tasks in ${entry.path}:`, err);
      });
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
    const project = await getProject(request.params.pid);
    if (!project) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    // Real bug caught by review: removing a project used to just
    // unregister it and stop the watcher, even while one of its
    // app-owned tasks was still actively being driven by this daemon's
    // own TaskRunner -- the loop kept running, mutating files under a
    // project directory the daemon no longer had any addressable
    // state/SSE route for. Cross-referencing every task id this project
    // actually has on disk against `taskRunner.isActive()` (the same
    // check the lineup/resume/cleanup routes already use) closes that:
    // a project with any genuinely active task is refused, not silently
    // orphaned.
    const rows = await listTasks(join(project.path, ".crewbench"));
    const activeTaskIds = rows.filter((row) => taskRunner.isActive(row.id)).map((row) => row.id);
    if (activeTaskIds.length > 0) {
      await reply.code(409).send({
        error: `project ${project.id} has ${activeTaskIds.length} task(s) still being driven by this daemon -- cancel or wait for them to finish before removing this project`,
      });
      return;
    }
    const removed = await removeProject(request.params.pid);
    if (!removed) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    await watcher.removeProject(request.params.pid);
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
