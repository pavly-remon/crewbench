import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { deleteTask, listCleanupCandidates, listTasks, loadState, TaskNotFinishedError } from "@crewbench/engine";
import { ApiCleanupCandidateListSchema, ApiDeleteTaskResponseSchema } from "@crewbench/contract";
import { getProject } from "../registry.js";
import type { DaemonWatcher } from "../watcher.js";
import type { TaskRunner } from "../task-runner.js";

/** `GET /api/projects/:pid/tasks/cleanup-candidates`,
 * `POST /api/tasks/:tid/delete` -- the new task-directory cleanup
 * mechanism. Manual only, always confirmed: this route pair only ever
 * *lists* candidates (never deletes anything on its own) and *deletes*
 * exactly one task per call, on an explicit request from the UI's own
 * confirmed-per-task dialog -- there is no bulk-delete, no scheduled/
 * automatic path anywhere in this daemon, matching the plugin side's own
 * `/crewbench:status --cleanup` precedent and the user's own explicit
 * design decision. `deleteTask()` itself re-checks the task's real,
 * current phase before touching anything (its own docstring has the
 * full story) -- this route doesn't duplicate that check, it just
 * surfaces `TaskNotFinishedError` as a real 409, not a 500.
 *
 * **Real gap caught by review, fixed here**: `deleteTask()` only reads
 * the on-disk `phase` -- a `driveTask()` loop that just reduced its way
 * to a terminal phase can still be mid-flight (writing `events.jsonl`,
 * about to persist a few more fields) for a brief window before it
 * actually exits and `TaskRunner` drops it from `active`. Deleting the
 * task directory during that window races the still-unwinding loop's
 * own writes, which could recreate files under a directory that no
 * longer exists or corrupt the index. `taskRunner.isActive()` -- the
 * same check `lineup.ts`/`task-control.ts` already use -- is consulted
 * here too, so cleanup is refused (409, not a race) for any task this
 * daemon still considers active, regardless of what its on-disk phase
 * says. */
export function registerTaskCleanupRoutes(app: FastifyInstance, watcher: DaemonWatcher, taskRunner: TaskRunner): void {
  app.get<{ Params: { pid: string }; Querystring: { older_than_days?: string } }>(
    "/api/projects/:pid/tasks/cleanup-candidates",
    async (request, reply) => {
      const project = await getProject(request.params.pid);
      if (!project) {
        await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
        return;
      }
      const olderThanDays = request.query.older_than_days ? Number(request.query.older_than_days) : 30;
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        await reply.code(400).send({ error: "older_than_days must be a non-negative number" });
        return;
      }
      const rows = await listTasks(join(project.path, ".crewbench"));
      const candidates = listCleanupCandidates(rows, olderThanDays);
      await reply.send(ApiCleanupCandidateListSchema.parse(candidates));
    },
  );

  app.post<{ Params: { tid: string } }>("/api/tasks/:tid/delete", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const state = await loadState(location.taskDir);
    if (state.owner !== "app") {
      await reply.code(403).send({ error: `task ${state.id} is not owned by the app -- it can't be deleted from here` });
      return;
    }
    if (taskRunner.isActive(state.id)) {
      await reply.code(409).send({ error: `task ${state.id} is still being driven by this daemon -- it can't be deleted while active` });
      return;
    }
    try {
      const result = await deleteTask(location.taskDir);
      watcher.unregisterTask(result.id);
      await reply.send(ApiDeleteTaskResponseSchema.parse({ deleted: result.id }));
    } catch (err) {
      if (err instanceof TaskNotFinishedError) {
        await reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
