import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { listTasks } from "@crewbench/engine";
import { ApiProjectUsageRowSchema, type ApiProjectUsageRow } from "@crewbench/contract";
import { getProject } from "../registry.js";
import { aggregateUsage } from "../task-detail.js";

/** `GET /api/projects/:pid/usage` (milestone 6's Usage page) -- one row
 * per task, reusing `task-detail.ts`'s `aggregateUsage()` (the exact same
 * per-role rollup `GET /api/tasks/:tid` already computes) rather than a
 * second implementation of "how do I total usage." */
export function registerUsageRoutes(app: FastifyInstance): void {
  app.get<{ Params: { pid: string } }>("/api/projects/:pid/usage", async (request, reply) => {
    const project = await getProject(request.params.pid);
    if (!project) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    const rows = await listTasks(join(project.path, ".crewbench"));
    const usageRows: ApiProjectUsageRow[] = await Promise.all(
      rows.map(async (row) => ({
        task_id: row.id,
        title: row.title ?? row.id,
        usage: await aggregateUsage(join(project.path, ".crewbench", "tasks", row.id)),
      })),
    );
    await reply.send(usageRows.map((row) => ApiProjectUsageRowSchema.parse(row)));
  });
}
