import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo } from "./helpers.js";

describe("POST /api/projects/:pid/tasks (Phase 3 milestone 3)", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }

  it("creates an app-owned task in the scoping phase, addressable immediately", async () => {
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-taskcreate-");
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string; path: string };

    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "Fix the login redirect bug" }),
    });
    expect(createRes.status).toBe(201);
    const detail = (await createRes.json()) as { id: string; title: string; phase: string; owner: string };
    expect(detail.owner).toBe("app");
    expect(detail.phase).toBe("scoping");
    expect(detail.title).toBe("Fix the login redirect bug");

    // Addressable immediately -- no dependency on the fs watcher's
    // debounced pickup of index.json (watcher.ts's registerTask()).
    const getRes = await fetch(url(`/api/tasks/${detail.id}`), { headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(getRes.status).toBe(200);

    const stateOnDisk = JSON.parse(await readFile(join(repo, ".crewbench", "tasks", detail.id, "state.json"), "utf-8")) as {
      owner?: string;
    };
    expect(stateOnDisk.owner).toBe("app");
  });

  it("returns 404 for an unknown project id", async () => {
    daemon = await startDaemon({ port: 0 });
    const res = await fetch(url("/api/projects/does-not-exist/tasks"), {
      method: "POST",
      headers: { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ task_text: "anything" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an empty task_text", async () => {
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-taskcreate-badreq-");
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };

    const res = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "" }),
    });
    expect(res.status).toBe(400);
  });
});
