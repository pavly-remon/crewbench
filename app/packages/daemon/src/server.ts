import Fastify, { type FastifyInstance } from "fastify";
import { createAuthHook, generateToken } from "./auth.js";
import { findOpenPort } from "./port.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerMutatingTaskRoutes } from "./routes/tasks-mutating.js";
import { registerScopingRoutes } from "./routes/scoping.js";
import { registerDoctorRoutes } from "./routes/doctor.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerTeamRoutes } from "./routes/team.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerLineupRoutes } from "./routes/lineup.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerTaskControlRoutes } from "./routes/task-control.js";
import { registerUiStatic } from "./static-ui.js";
import { DEFAULT_PORT, loadConfig } from "./config.js";
import { loadRegistry } from "./registry.js";
import { DaemonWatcher } from "./watcher.js";
import { TaskRunner } from "./task-runner.js";

export interface DaemonHandle {
  app: FastifyInstance;
  token: string;
  port: number;
  watcher: DaemonWatcher;
  taskRunner: TaskRunner;
  close: () => Promise<void>;
}

export interface StartDaemonOptions {
  /** Overrides config.json's port and the built-in default -- `crewbench
   * ui --port N`. */
  port?: number;
}

/** Builds and starts the daemon: binds 127.0.0.1 only (never 0.0.0.0, per
 * docs/app/CONTEXT.md's non-negotiable principle 6 extended to this
 * phase's own "loopback only" requirement), generates a fresh in-memory
 * auth token, and registers every route behind the auth hook. Read-only
 * this phase -- no task-mutating routes exist yet (Phase 3). Starts a
 * `DaemonWatcher` (Phase 2 milestone 2) and seeds it with every already
 * -registered project, so a restarted daemon has a live task index and
 * SSE-replayable state again without anyone re-adding a project. */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const config = await loadConfig();
  const preferredPort = options.port ?? config.port ?? DEFAULT_PORT;
  const port = await findOpenPort(preferredPort);
  const token = generateToken();

  // forceCloseConnections: an open SSE stream is a long-lived keep-alive
  // connection by design -- without this, Fastify's close() waits for it
  // to end on its own (it may not, if a client's abort hasn't fully
  // propagated to the socket yet), hanging shutdown. Safe here since a
  // daemon shutdown legitimately means "every stream ends now."
  const app = Fastify({ logger: false, forceCloseConnections: true });
  app.addHook("onRequest", createAuthHook(token, port));

  const watcher = new DaemonWatcher();
  const taskRunner = new TaskRunner(watcher, config.concurrency ?? {});
  const registry = await loadRegistry();
  await Promise.all(Object.values(registry).map((p) => watcher.addProject(p)));
  // Reattach every app-owned, non-terminal task (Phase 3 milestone 1's
  // Design decision 3) -- after the watcher has indexed every project's
  // tasks (above), so rehydrateState()/listTasks() see a consistent
  // on-disk picture. A reattach failure for one project must never take
  // the rest of startup down with it.
  await Promise.all(
    Object.values(registry).map((p) =>
      taskRunner.reattachProject(p.path).catch((err: unknown) => {
        console.error(`failed to reattach tasks in ${p.path}:`, err);
      }),
    ),
  );

  await registerProjectRoutes(app, watcher, taskRunner);
  registerEventRoutes(app, watcher);
  registerTaskRoutes(app, watcher, taskRunner);
  registerMutatingTaskRoutes(app, watcher, taskRunner);
  registerScopingRoutes(app, watcher, taskRunner);
  registerDoctorRoutes(app);
  registerUsageRoutes(app);
  registerTeamRoutes(app);
  registerProfileRoutes(app);
  registerLineupRoutes(app, watcher, taskRunner);
  registerApprovalRoutes(app, watcher, taskRunner);
  registerTaskControlRoutes(app, watcher, taskRunner);
  await registerUiStatic(app);

  await app.listen({ host: "127.0.0.1", port });

  return {
    app,
    token,
    port,
    watcher,
    taskRunner,
    close: async () => {
      await watcher.close();
      await app.close();
    },
  };
}
