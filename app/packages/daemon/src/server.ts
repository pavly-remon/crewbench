import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
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
import { registerModelRoutes } from "./routes/models.js";
import { registerFsBrowseRoutes } from "./routes/fs-browse.js";
import { registerPluginInstallRoutes } from "./routes/plugin-install.js";
import { registerTaskCleanupRoutes } from "./routes/task-cleanup.js";
import { registerCapabilityRoutes, registerPtyRoutes } from "./routes/pty.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerUpdateCheckRoutes } from "./routes/update-check.js";
import { registerUiStatic } from "./static-ui.js";
import { DEFAULT_PORT, loadConfig } from "./config.js";
import { loadRegistry } from "./registry.js";
import { DaemonWatcher } from "./watcher.js";
import { TaskRunner } from "./task-runner.js";
import { DaemonAlreadyRunningError, LIVENESS_MARKER, LIVENESS_PATH, probeExistingDaemon } from "./singleton.js";

export { DaemonAlreadyRunningError } from "./singleton.js";

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
  /** Phase 4 milestone 3: the real `crewbench` CLI entry file the
   * embedded-terminal PTY channel (`routes/pty.ts`) re-invokes as
   * `<execPath> <cliEntryPath> resume <task-id>` -- **not** read from
   * `process.argv[1]` inside that route itself, a real bug this
   * milestone's own test caught live: `process.argv[1]` is whichever
   * script launched *this* process, which is `crewbench`'s own `bin.js`
   * when started via `crewbench ui`, but is the test runner's own entry
   * script when `startDaemon()` is called from a test (or, in principle,
   * from any other embedder of this package) -- silently spawning the
   * wrong program. Defaults to `process.argv[1]` (correct for the real
   * `crewbench ui` case, unchanged behavior for every existing caller),
   * with an explicit override so tests can point it at a real,
   * fully-controlled fake CLI entry instead. */
  cliEntryPath?: string;
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
  // Phase 4 milestone 4 (Design decision 4): `preferred === 0` is the
  // ephemeral-port sentinel `findOpenPort()` itself already special-cases
  // (every test in this codebase calls `startDaemon({port: 0})` for
  // exactly this reason, to avoid colliding with anything else, including
  // each other) -- the singleton check only makes sense for a real,
  // specific preferred port (the actual `crewbench ui`/`crewbench ui
  // --port N` case), so it's skipped here rather than probing port 0
  // (meaningless) or racing every parallel test file against one shared
  // "is something on port 0" question.
  if (preferredPort !== 0 && (await probeExistingDaemon(preferredPort))) {
    throw new DaemonAlreadyRunningError(preferredPort);
  }
  const port = await findOpenPort(preferredPort);
  const token = generateToken();

  // forceCloseConnections: an open SSE stream is a long-lived keep-alive
  // connection by design -- without this, Fastify's close() waits for it
  // to end on its own (it may not, if a client's abort hasn't fully
  // propagated to the socket yet), hanging shutdown. Safe here since a
  // daemon shutdown legitimately means "every stream ends now."
  const app = Fastify({ logger: false, forceCloseConnections: true });
  // Unauthenticated by construction (auth.ts's own hook exempts anything
  // outside /api/, the same exemption static UI assets already get) --
  // this route exists purely so a *different, about-to-start* daemon
  // process can ask "is a real crewbench daemon already here" via
  // singleton.ts's probeExistingDaemon(), before this app.listen() call
  // below even happens. No secrets in the response.
  app.get(LIVENESS_PATH, async () => ({ marker: LIVENESS_MARKER, pid: process.pid }));
  app.addHook("onRequest", createAuthHook(token, port));
  // Registered before every route (per @fastify/websocket's own README:
  // "it needs to be registered before all routes in order to be able to
  // intercept websocket connections"), so routes/pty.ts's `{ websocket:
  // true }` route can exist at all.
  await app.register(fastifyWebsocket);

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
  registerModelRoutes(app);
  registerFsBrowseRoutes(app);
  registerPluginInstallRoutes(app);
  registerTaskCleanupRoutes(app, watcher);
  registerCapabilityRoutes(app);
  registerConfigRoutes(app);
  registerUpdateCheckRoutes(app);
  const cliEntryPath = options.cliEntryPath ?? (process.argv[1] as string);
  registerPtyRoutes(app, watcher, taskRunner, cliEntryPath);
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
