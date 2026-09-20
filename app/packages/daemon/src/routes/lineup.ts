import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { atomicWriteJson, loadState, readJsonOrDefault, setField } from "@crewbench/engine";
import { ApiLineupRequestSchema, ApiTaskDetailSchema, type Team } from "@crewbench/contract";
import type { DaemonWatcher } from "../watcher.js";
import type { TaskRunner } from "../task-runner.js";
import { buildTaskDetail } from "../task-detail.js";

/** `POST /api/tasks/:tid/lineup` (Phase 3 milestone 4) -- see
 * `@crewbench/contract`'s `ApiLineupRequestSchema` docstring for why this
 * endpoint exists beyond the phase prompt's literal milestone 4 bullet.
 * One-shot: a task can only be started once, so this 400s if `lineup` is
 * already non-empty (matching `commands/run.ts`'s own real order --
 * lineup is resolved and confirmed exactly once, before the fix loop
 * ever starts) or if scoping hasn't been finalized yet (`spec_file` is
 * still null -- there is nothing to build a lineup for otherwise). */
export function registerLineupRoutes(app: FastifyInstance, watcher: DaemonWatcher, taskRunner: TaskRunner): void {
  app.post<{ Params: { tid: string }; Body: unknown }>("/api/tasks/:tid/lineup", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const state = await loadState(location.taskDir);
    if (state.owner !== "app") {
      await reply.code(403).send({ error: `task ${state.id} is not owned by the app -- it can't be started from here` });
      return;
    }
    if (!state.spec_file) {
      await reply.code(400).send({ error: `task ${state.id} has no finalized spec yet -- finish scoping first` });
      return;
    }
    const hasLineup = Object.keys((state.lineup as Record<string, unknown>) ?? {}).length > 0;
    if (hasLineup) {
      await reply.code(400).send({ error: `task ${state.id} already has a lineup -- it can only be started once` });
      return;
    }

    const parsed = ApiLineupRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    const { roles, save_as_default } = parsed.data;

    await setField(location.taskDir, "lineup", roles);

    if (save_as_default) {
      const teamPath = join(location.projectPath, ".crewbench", "team.json");
      const team = await readJsonOrDefault<Team>(teamPath, {});
      await atomicWriteJson(teamPath, { ...team, roles: { ...team.roles, ...roles } });
    }

    const freshState = await loadState(location.taskDir);
    await taskRunner.startTask(state.id, location.taskDir, location.projectPath, freshState);

    const detail = await buildTaskDetail(location);
    await reply.send(ApiTaskDetailSchema.parse(detail));
  });
}
