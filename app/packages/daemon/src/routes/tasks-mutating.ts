import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createTask, makeTaskId, TaskAlreadyExistsError } from "@crewbench/engine";
import { ApiCreateTaskRequestSchema, ApiTaskDetailSchema } from "@crewbench/contract";
import { getProject } from "../registry.js";
import type { DaemonWatcher } from "../watcher.js";
import { buildTaskDetail } from "../task-detail.js";
import type { TaskRunner } from "../task-runner.js";

/** `POST /api/projects/:pid/tasks` (Phase 3 milestone 3) -- creates an
 * app-owned task in the `"scoping"` phase, title defaulted from the raw
 * task text (same 60-char truncation `commands/run.ts` uses before a
 * real spec exists to take the title from). The scoping conversation
 * itself is a separate call (`POST .../scoping/messages`) the UI makes
 * right after -- this endpoint's only job is to get a real `taskDir` on
 * disk, addressable by id, before that conversation's `scoping_session_id`
 * has anywhere to persist to. */
export function registerMutatingTaskRoutes(app: FastifyInstance, watcher: DaemonWatcher, taskRunner: TaskRunner): void {
  app.post<{ Params: { pid: string }; Body: unknown }>("/api/projects/:pid/tasks", async (request, reply) => {
    const project = await getProject(request.params.pid);
    if (!project) {
      await reply.code(404).send({ error: `no such project: ${request.params.pid}` });
      return;
    }
    const parsed = ApiCreateTaskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    const { task_text: taskText, jira_key: jiraKey } = parsed.data;
    const title = taskText.slice(0, 60);

    // Real, disclosed bug fix (Copilot review #11): makeTaskId()'s
    // 16-bit random suffix can genuinely collide (task-store.ts's own
    // TaskAlreadyExistsError docstring has the full story) -- createTask()
    // now refuses to silently overwrite an existing task's state.json
    // rather than clobbering it, so a collision here is retried with a
    // freshly-minted id instead of surfacing as a confusing 500. A tight
    // bound (5 attempts) is plenty: even a genuine collision is rare
    // enough that needing a second attempt should itself be rare.
    let taskId = "";
    let taskDir = "";
    for (let attempt = 0; ; attempt++) {
      taskId = makeTaskId(taskText);
      taskDir = join(project.path, ".crewbench", "tasks", taskId);
      try {
        await createTask(taskDir, { id: taskId, command: "new-task", title, jiraKey: jiraKey ?? null, owner: "app" });
        break;
      } catch (err) {
        if (err instanceof TaskAlreadyExistsError && attempt < 4) continue;
        throw err;
      }
    }

    // See watcher.ts's registerTask() docstring -- registered immediately
    // rather than waiting for the fs watcher's own debounced index.json
    // pickup, since the client's very next call is likely
    // POST .../scoping/messages against this same task id.
    watcher.registerTask(project.id, project.path, taskId);

    const detail = await buildTaskDetail({ projectId: project.id, projectPath: project.path, taskDir }, taskRunner);
    await reply.code(201).send(ApiTaskDetailSchema.parse(detail));
  });
}
