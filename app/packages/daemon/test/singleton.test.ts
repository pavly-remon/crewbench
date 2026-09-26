import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, DaemonAlreadyRunningError, type DaemonHandle } from "../src/server.js";
import { findOpenPort } from "../src/port.js";

describe("daemon singleton check (Phase 4 milestone 4)", () => {
  let daemon: DaemonHandle | null = null;
  const savedEnv = { ...process.env };
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-singleton-home-"));
    process.env.CREWBENCH_HOME = home;
  });

  afterEach(async () => {
    if (daemon) await daemon.close();
    daemon = null;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it("refuses to start a second daemon on the same preferred port a real crewbench daemon already occupies", async () => {
    // A genuinely free port reserved right before use, not a hardcoded
    // number -- avoids colliding with anything else already running on
    // this machine or with another parallel test file.
    const port = await findOpenPort(40100);
    daemon = await startDaemon({ port });
    expect(daemon.port).toBe(port);

    await expect(startDaemon({ port })).rejects.toThrow(DaemonAlreadyRunningError);
    await expect(startDaemon({ port })).rejects.toThrow(`http://127.0.0.1:${port}`);
  });

  it("still starts normally (walking forward) when the preferred port is occupied by something that is NOT a crewbench daemon", async () => {
    const port = await findOpenPort(40200);
    // A plain TCP server, not a crewbench daemon -- probeExistingDaemon()
    // must correctly read this as "no crewbench daemon here" and let
    // findOpenPort()'s own existing forward-scan behavior take over,
    // exactly as it did before this milestone.
    const net = await import("node:net");
    const plain = net.createServer();
    // Tracked and force-destroyed below, not left to `Server.close()`'s
    // own callback to wait for -- probeExistingDaemon()'s own fetch()
    // against this server gets aborted client-side (by design, its own
    // 300ms timeout), but that leaves the *server's* accepted socket
    // still open; `close()`'s callback only fires once every existing
    // connection actually ends, which this abandoned one never does on
    // its own. A real hang, caught live by this test itself timing out
    // on its own cleanup, not a probe/detection bug.
    const sockets = new Set<import("node:net").Socket>();
    plain.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => plain.listen(port, "127.0.0.1", resolve));
    try {
      daemon = await startDaemon({ port });
      expect(daemon.port).not.toBe(port); // walked forward, didn't throw
      expect(daemon.port).toBeGreaterThan(port);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
  });

  /** The real race review caught: the old probe-then-bind sequence had
   * no mutual exclusion at all, so two `startDaemon({port})` calls fired
   * at the same instant could each run `probeExistingDaemon()` before
   * either had bound anything, then each independently resolve
   * `findOpenPort()` -- timing-dependently landing on the same port
   * (one wins the real bind, the other's `app.listen()` throws a raw,
   * unhandled bind error, not the clean `DaemonAlreadyRunningError` this
   * whole check exists to produce) or, worse, on two different ports
   * (two live, mutually-unaware daemons). Fired genuinely concurrently
   * here (`Promise.allSettled`, not two sequential `await`s) so this
   * exercises real interleaved async scheduling, not an artificially
   * staggered pair -- proves exactly one call ever ends up bound to
   * `port`, and the other specifically gets `DaemonAlreadyRunningError`,
   * not some other crash. */
  it("two startDaemon() calls fired at the same instant for the same port: exactly one binds, the other gets a clean DaemonAlreadyRunningError, not a race", async () => {
    const port = await findOpenPort(40150);
    const results = await Promise.allSettled([startDaemon({ port }), startDaemon({ port })]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<DaemonHandle> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]!.value.port).toBe(port);
    expect(rejected[0]!.reason).toBeInstanceOf(DaemonAlreadyRunningError);

    daemon = fulfilled[0]!.value;
  });

  it("skips the singleton check entirely for the ephemeral-port sentinel (port: 0), same as every other test in this suite relies on", async () => {
    const port = await findOpenPort(40300);
    const first = await startDaemon({ port });
    // A second daemon requesting an OS-assigned ephemeral port must
    // never be refused just because *some* daemon happens to be running
    // -- the check is scoped to "the exact preferred port," not "any
    // daemon anywhere."
    const second = await startDaemon({ port: 0 });
    try {
      expect(second.port).not.toBe(first.port);
    } finally {
      await second.close();
      daemon = first;
    }
  });
});
