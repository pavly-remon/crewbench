import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ApiRunLogSchema, ApiTaskDetailSchema } from "@crewbench/contract";
import type { DaemonWatcher } from "../watcher.js";
import { buildTaskDetail } from "../task-detail.js";

const MAX_LOG_READ_BYTES = 1_000_000;

export function registerTaskRoutes(app: FastifyInstance, watcher: DaemonWatcher): void {
  app.get<{ Params: { tid: string } }>("/api/tasks/:tid", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const detail = await buildTaskDetail(location);
    await reply.send(ApiTaskDetailSchema.parse(detail));
  });

  /** `GET /api/tasks/:tid/runs/:run/log?from=offset` -- incremental read
   * of one run's `.log` file, the same byte-offset contract
   * `packages/daemon`'s own event tailer uses (`tail.ts`), reused here
   * for a plain still-growing text file instead of a line-delimited
   * event log. Capped at `MAX_LOG_READ_BYTES` per call so a client that
   * falls far behind (or passes `from=0` on a huge log) can't force one
   * response to buffer an unbounded amount of text in memory -- it gets
   * a `next_offset` short of the file's real end and is expected to poll
   * again. */
  app.get<{ Params: { tid: string; run: string }; Querystring: { from?: string } }>(
    "/api/tasks/:tid/runs/:run/log",
    async (request, reply) => {
      const location = watcher.resolveTask(request.params.tid);
      if (!location) {
        await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
        return;
      }
      const logPath = join(location.taskDir, "runs", `${request.params.run}.log`);
      if (!existsSync(logPath)) {
        await reply.code(404).send({ error: `no such run: ${request.params.run}` });
        return;
      }
      const from = Number(request.query.from ?? "0");
      const start = Number.isFinite(from) && from >= 0 ? from : 0;

      const handle = await open(logPath, "r");
      try {
        const stat = await handle.stat();
        if (stat.size <= start) {
          await reply.send(ApiRunLogSchema.parse({ text: "", next_offset: start }));
          return;
        }
        const length = Math.min(stat.size - start, MAX_LOG_READ_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        await reply.send(ApiRunLogSchema.parse({ text: buffer.toString("utf-8"), next_offset: start + length }));
      } finally {
        await handle.close();
      }
    },
  );
}
