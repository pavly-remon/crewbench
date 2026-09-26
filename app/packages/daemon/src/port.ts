import { createServer } from "node:net";

/** True if `port` is free to bind on 127.0.0.1 right now. Used only to
 * pick a starting port before Fastify itself binds (see `findOpenPort`) --
 * inherently a check-then-act race against anything else on the machine,
 * same as every "is this port free" check anywhere; Fastify's own listen()
 * is still the final authority and can itself fail if something grabs the
 * port in between. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/** Asks the OS to assign any free ephemeral port -- `preferred === 0` is
 * the standard "OS picks" sentinel (same meaning `net`/`http`'s own
 * `listen(0)` gives it), used by tests that don't care which port they
 * get. Resolved up front (not left to Fastify's own `listen({port: 0})`)
 * because the auth hook's Origin allowlist (`auth.ts`) needs the concrete
 * port *before* the server starts accepting requests. */
function pickEphemeralPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => (port ? resolvePromise(port) : reject(new Error("could not determine ephemeral port"))));
    });
  });
}

/** Tries `preferred`, then scans upward for the next free port -- the
 * phase prompt: "pick a fixed one, and fall back if it is busy." Gives up
 * after `maxAttempts` to avoid scanning forever on a machine with an
 * unusual firewall/port-range setup. `preferred === 0` skips straight to
 * `pickEphemeralPort()` (see its docstring). */
export async function findOpenPort(preferred: number, maxAttempts = 50): Promise<number> {
  if (preferred === 0) return pickEphemeralPort();
  for (let port = preferred; port < preferred + maxAttempts; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port found starting at ${preferred} (tried ${maxAttempts} ports)`);
}
