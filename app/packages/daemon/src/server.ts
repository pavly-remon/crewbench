import Fastify, { type FastifyInstance } from "fastify";
import { createAuthHook, generateToken } from "./auth.js";
import { findOpenPort } from "./port.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { DEFAULT_PORT, loadConfig } from "./config.js";

export interface DaemonHandle {
  app: FastifyInstance;
  token: string;
  port: number;
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
 * this phase -- no task-mutating routes exist yet (Phase 3). */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const config = await loadConfig();
  const preferredPort = options.port ?? config.port ?? DEFAULT_PORT;
  const port = await findOpenPort(preferredPort);
  const token = generateToken();

  const app = Fastify({ logger: false });
  app.addHook("onRequest", createAuthHook(token, port));

  await registerProjectRoutes(app);

  await app.listen({ host: "127.0.0.1", port });

  return {
    app,
    token,
    port,
    close: () => app.close(),
  };
}
