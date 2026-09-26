import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { loadState } from "@crewbench/engine";
import { detectPtyCapability, loadPty } from "../pty-capability.js";
import type { DaemonWatcher } from "../watcher.js";
import type { TaskRunner } from "../task-runner.js";

interface ClientMessage {
  type: "input" | "resize";
  data?: string;
  cols?: number;
  rows?: number;
}

/** `GET /api/capabilities`, `GET /api/tasks/:tid/pty` (Phase 4 milestone
 * 3). The capability flag is what gates the UI's "Open session" button
 * at all (Design decision 3) -- `pty: false` means the embedded terminal
 * genuinely isn't available on this machine right now (`node-pty` never
 * installed, or installed but its real test-spawn failed --
 * `pty-capability.ts`'s own docstring has the full story), and the UI
 * falls back to the existing "Copy resume command" button instead. */
export function registerCapabilityRoutes(app: FastifyInstance): void {
  app.get("/api/capabilities", async (_request, reply) => {
    const pty = detectPtyCapability();
    await reply.send({ pty: pty.available });
  });
}

/** The actual session channel. **Gated server-side, not just by the UI
 * hiding its own button** (finding 7's own real hazard: `crewbench
 * resume <id>` run from a terminal against a task the daemon's own
 * `TaskRunner` is already actively driving in-process would start a
 * second, concurrent `driveTask()` loop racing the first): a
 * `preHandler` hook runs before the WebSocket upgrade completes
 * (`@fastify/websocket`'s own documented hook-ordering guarantee --
 * `onRequest`/`preParsing`/`preValidation`/`preHandler` all run before
 * the connection opens, and a `reply.code(...).send(...)` from one of
 * them refuses the upgrade outright, confirmed against the package's own
 * README before relying on it) checking the *identical* condition
 * `task-controls.tsx`'s own `canResume` checks client-side
 * (`!detail.active && (phase === "stopped" || phase === "failed")`), not
 * a re-derived approximation of it -- `taskRunner.isActive(taskId)` is
 * the same method `buildTaskDetail()` already calls to produce
 * `detail.active` in the first place. */
export function registerPtyRoutes(app: FastifyInstance, watcher: DaemonWatcher, taskRunner: TaskRunner, cliEntryPath: string): void {
  app.get<{ Params: { tid: string } }>(
    "/api/tasks/:tid/pty",
    {
      websocket: true,
      preHandler: async (request, reply) => {
        const cap = detectPtyCapability();
        if (!cap.available) {
          await reply.code(503).send({ error: `embedded terminal unavailable: ${cap.reason}` });
          return;
        }
        const location = watcher.resolveTask(request.params.tid);
        if (!location) {
          await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
          return;
        }
        const state = await loadState(location.taskDir);
        if (state.owner !== "app") {
          await reply.code(403).send({ error: `task ${state.id} is not owned by the app -- it can't be resumed from here` });
          return;
        }
        if (taskRunner.isActive(state.id)) {
          await reply.code(409).send({ error: `task ${state.id} is already being driven by this daemon -- opening a second session would race it` });
          return;
        }
        if (state.phase !== "stopped" && state.phase !== "failed") {
          await reply.code(409).send({ error: `task ${state.id} is in phase "${state.phase}" -- only a stopped or failed task can be resumed` });
          return;
        }
      },
    },
    (socket: WebSocket, request) => {
      const location = watcher.resolveTask(request.params.tid);
      // The preHandler above already proved this resolves -- re-checked
      // here only because TypeScript can't see across the two handlers;
      // a real race (the task vanishing between preHandler and here) is
      // vanishingly unlikely for a locally-registered project and, if it
      // ever happened, closing the socket immediately is the correct,
      // safe behavior anyway.
      if (!location) {
        socket.close(1011, "task no longer resolvable");
        return;
      }

      const pty = loadPty();
      // The exact same binary/version currently running this daemon
      // (`cliEntryPath`, resolved once by `startDaemon()` -- see its own
      // docstring for the real process.argv[1]-in-a-test bug this
      // parameter exists to fix) -- not a separate `crewbench` lookup on
      // `PATH`, which could resolve to a different globally-installed
      // version or nothing at all in a test environment. Reproduces
      // `crewbench resume <task-id>` exactly (`resume.ts` itself reads
      // `process.cwd()` for the project root, matching
      // `CopyResumeCommand`'s own `cd <projectPath> && crewbench resume
      // <id>` string, Phase 3 milestone 6).
      const child = pty.spawn(process.execPath, [cliEntryPath, "resume", request.params.tid], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: location.projectPath,
        env: process.env as Record<string, string>,
      });

      child.onData((data) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "output", data }));
      });
      child.onExit(({ exitCode }) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "exit", code: exitCode }));
        socket.close(1000, "session ended");
      });

      socket.on("message", (raw: Buffer) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          return; // malformed frame -- ignore rather than crash the session
        }
        if (msg.type === "input" && typeof msg.data === "string") {
          child.write(msg.data);
        } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          child.resize(msg.cols, msg.rows);
        }
      });
      socket.on("close", () => {
        child.kill();
      });
    },
  );
}
