import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo } from "./helpers.js";

describe("GET/PUT /api/projects/:pid/team (Phase 3 milestone 4)", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };
  // Real, pre-existing isolation gap fixed here -- see
  // test/fs-browse.test.ts's own comment for the full story
  // (`daemonHome()` defaults to the real `~/.crewbench` without this).
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-team-home-"));
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

  async function addProject(headers: Record<string, string>): Promise<{ id: string; path: string }> {
    const repo = await gitRepo("crewbench-team-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    return (await addRes.json()) as { id: string; path: string };
  }

  it("returns {} when no team.json exists yet, not a 404", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const project = await addProject(headers);

    const res = await fetch(url(`/api/projects/${project.id}/team`), { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("saves a team roster and reads it back, and writes the real team.json file", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const project = await addProject(headers);

    const team = {
      roles: { developer: { cli: "codex", model: "strong", effort: "high", permissions: "safe" } },
      loop: { max_rounds: 5, fix_threshold: "minor" },
    };
    const putRes = await fetch(url(`/api/projects/${project.id}/team`), { method: "PUT", headers, body: JSON.stringify(team) });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual(team);

    const getRes = await fetch(url(`/api/projects/${project.id}/team`), { headers });
    expect(await getRes.json()).toEqual(team);

    const onDisk = JSON.parse(await readFile(join(project.path, ".crewbench", "team.json"), "utf-8"));
    expect(onDisk).toEqual(team);
  });

  it("rejects a team.json shape that fails TeamSchema", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const project = await addProject(headers);

    const res = await fetch(url(`/api/projects/${project.id}/team`), {
      method: "PUT",
      headers,
      body: JSON.stringify({ roles: { developer: { cli: "not-a-real-cli" } } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown project id on both GET and PUT", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    expect((await fetch(url("/api/projects/does-not-exist/team"), { headers })).status).toBe(404);
    expect((await fetch(url("/api/projects/does-not-exist/team"), { method: "PUT", headers, body: "{}" })).status).toBe(404);
  });
});
