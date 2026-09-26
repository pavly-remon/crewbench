import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";

describe("GET/PUT /api/config (Phase 4 milestone 4)", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-config-home-"));
    process.env.CREWBENCH_HOME = home;
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }

  it("returns {} when no config.json exists yet, not a 404", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/config"), { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("saves default_lineup/notifications/theme and reads them back, and writes the real config.json file", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const body = {
      default_lineup: { developer: { cli: "claude", model: "sonnet", effort: "medium", permissions: "safe" } },
      notifications: true,
      theme: "dark",
    };
    const putRes = await fetch(url("/api/config"), { method: "PUT", headers, body: JSON.stringify(body) });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual(body);

    const getRes = await fetch(url("/api/config"), { headers });
    expect(await getRes.json()).toEqual(body);

    const onDisk = JSON.parse(await readFile(join(home, "config.json"), "utf-8"));
    expect(onDisk).toEqual(body);
  });

  it("rejects an invalid theme value", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const res = await fetch(url("/api/config"), { method: "PUT", headers, body: JSON.stringify({ theme: "neon" }) });
    expect(res.status).toBe(400);
  });

  it("existing port/concurrency fields still round-trip alongside the three new ones", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const body = { port: 5555, concurrency: { claude: 2 }, notifications: false, theme: "light" };
    await fetch(url("/api/config"), { method: "PUT", headers, body: JSON.stringify(body) });
    const res = await fetch(url("/api/config"), { headers });
    expect(await res.json()).toEqual(body);
  });
});
