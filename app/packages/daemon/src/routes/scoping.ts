import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { continueScoping, loadState, setField, startScoping } from "@crewbench/engine";
import { ApiFinalizeScopingRequestSchema, ApiScopingMessageRequestSchema, ApiTaskDetailSchema, type ApiScopingStreamEvent } from "@crewbench/contract";
import type { Cli, Effort } from "@crewbench/adapters";
import type { DaemonWatcher } from "../watcher.js";
import { buildTaskDetail } from "../task-detail.js";
import { startSse, writeSseEvent } from "../sse.js";

/** `POST /api/tasks/:tid/scoping/messages` and `.../scoping/finalize`
 * (Phase 3 milestone 3). Only ever touches an app-owned task -- a
 * plugin-created or `crewbench run`-created task's scoping conversation
 * already finished (or is being driven) by its own process before it
 * ever reaches state the daemon can see, and the daemon must never
 * resolve/continue a conversation it didn't start (same ownership rule
 * Design decision 5 applies everywhere else). */
export function registerScopingRoutes(app: FastifyInstance, watcher: DaemonWatcher): void {
  app.post<{ Params: { tid: string }; Body: unknown }>("/api/tasks/:tid/scoping/messages", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const state = await loadState(location.taskDir);
    if (state.owner !== "app") {
      await reply.code(403).send({ error: `task ${state.id} is not owned by the app -- it can't be scoped from here` });
      return;
    }

    const parsed = ApiScopingMessageRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    const { message, cli: bodyCli, model: bodyModel, effort: bodyEffort } = parsed.data;

    const sessionId = (state.scoping_session_id as string | null | undefined) ?? null;
    let cli: Cli;
    let model: string;
    const effort: Effort = (bodyEffort ?? (state.scoping_effort as Effort | undefined) ?? "medium") as Effort;

    if (sessionId) {
      // A conversation is already in flight -- resume with whatever CLI/
      // model started it (persisted on the first turn below), ignoring
      // any cli/model the client sent this time. A scoping session can't
      // change CLI mid-conversation: the session id only means something
      // to the CLI that issued it.
      const persistedCli = state.scoping_cli as string | undefined;
      const persistedModel = state.scoping_model as string | undefined;
      if (!persistedCli || !persistedModel) {
        await reply.code(500).send({ error: `task ${state.id} has a scoping_session_id but no persisted scoping_cli/scoping_model` });
        return;
      }
      cli = persistedCli as Cli;
      model = persistedModel;
    } else {
      if (!bodyCli || !bodyModel) {
        await reply.code(400).send({ error: "cli and model are required for the first scoping message" });
        return;
      }
      cli = bodyCli;
      model = bodyModel;
      await setField(location.taskDir, "scoping_cli", cli);
      await setField(location.taskDir, "scoping_model", model);
      await setField(location.taskDir, "scoping_effort", effort);
    }

    const sse = startSse(reply);
    const onChunk = (text: string): void => {
      writeSseEvent(reply, "", { type: "chunk", text } satisfies ApiScopingStreamEvent);
    };

    try {
      const result = sessionId
        ? await continueScoping(cli, model, effort, message, sessionId, location.projectPath, onChunk)
        : await startScoping(cli, model, effort, message, location.projectPath, state.jira_key ?? null, onChunk);

      await setField(location.taskDir, "scoping_session_id", result.sessionId ?? null);

      writeSseEvent(reply, "", {
        type: "done",
        ok: result.ok,
        error: result.error,
        reply: result.ok ? result.reply : null,
        session_id: result.sessionId,
        spec: result.spec,
      } satisfies ApiScopingStreamEvent);
    } finally {
      sse.close();
      reply.raw.end();
    }
  });

  /** `POST /api/tasks/:tid/scoping/finalize` -- writes `spec.json`
   * exactly as `commands/run.ts` does, clears `scoping_session_id` (the
   * conversation that produced it is over; nothing resumes it after
   * this), and returns the task's now-updated detail so the UI can move
   * straight to the lineup step (milestone 4) without a second fetch. */
  app.post<{ Params: { tid: string }; Body: unknown }>("/api/tasks/:tid/scoping/finalize", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const state = await loadState(location.taskDir);
    if (state.owner !== "app") {
      await reply.code(403).send({ error: `task ${state.id} is not owned by the app -- it can't be finalized from here` });
      return;
    }

    const parsed = ApiFinalizeScopingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    const spec = parsed.data;

    const specPath = join(location.taskDir, "spec.json");
    await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", "utf-8");
    await setField(location.taskDir, "spec_file", specPath);
    await setField(location.taskDir, "acceptance_criteria", spec.acceptance_criteria);
    await setField(location.taskDir, "title", spec.title);
    await setField(location.taskDir, "scoping_session_id", null);

    const detail = await buildTaskDetail(location);
    await reply.send(ApiTaskDetailSchema.parse(detail));
  });
}
