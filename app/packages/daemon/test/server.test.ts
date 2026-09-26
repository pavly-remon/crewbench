import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { createTask } from "@crewbench/engine";
import { makeTaskId } from "@crewbench/engine";

const execFileAsync = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-daemon-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "hello\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("daemon server", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-home-"));
    process.env.CREWBENCH_HOME = home;
    daemon = await startDaemon({ port: 0 });
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }

  it("binds only to 127.0.0.1, not 0.0.0.0", () => {
    const address = daemon.app.server.address();
    expect(address).not.toBeNull();
    expect(typeof address === "object" ? address?.address : address).toBe("127.0.0.1");
  });

  it("rejects requests with no bearer token", async () => {
    const res = await fetch(url("/api/projects"));
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong bearer token", async () => {
    const res = await fetch(url("/api/projects"), { headers: { Authorization: "Bearer wrong-token" } });
    expect(res.status).toBe(401);
  });

  it("rejects requests from a disallowed Origin even with a valid token", async () => {
    const res = await fetch(url("/api/projects"), {
      headers: { Authorization: `Bearer ${daemon.token}`, Origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts a request with the right token and no Origin header (non-browser client)", async () => {
    const res = await fetch(url("/api/projects"), { headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("accepts a request with the right token and a matching Origin", async () => {
    const res = await fetch(url("/api/projects"), {
      headers: { Authorization: `Bearer ${daemon.token}`, Origin: `http://127.0.0.1:${daemon.port}` },
    });
    expect(res.status).toBe(200);
  });

  it("adds a project, rejects a non-git path, then lists and removes it", async () => {
    const repo = await gitRepo();
    const notGit = await mkdtemp(join(tmpdir(), "crewbench-notgit-"));
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    const badRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: notGit }) });
    expect(badRes.status).toBe(400);

    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo, name: "demo" }) });
    expect(addRes.status).toBe(201);
    const added = (await addRes.json()) as { id: string; name: string; active_task_count: number };
    expect(added.name).toBe("demo");
    expect(added.active_task_count).toBe(0);

    const listRes = await fetch(url("/api/projects"), { headers: { Authorization: `Bearer ${daemon.token}` } });
    const projects = (await listRes.json()) as Array<{ id: string }>;
    expect(projects.map((p) => p.id)).toContain(added.id);

    const delRes = await fetch(url(`/api/projects/${added.id}`), { method: "DELETE", headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(delRes.status).toBe(204);

    const listAfter = await fetch(url("/api/projects"), { headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(await listAfter.json()).toEqual([]);
  });

  it("lists a project's tasks from its .crewbench/index.json", async () => {
    const repo = await gitRepo();
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const added = (await addRes.json()) as { id: string };

    const taskId = makeTaskId("add a widget");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Add a widget" });

    const tasksRes = await fetch(url(`/api/projects/${added.id}/tasks`), { headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(tasksRes.status).toBe(200);
    const tasks = (await tasksRes.json()) as Array<{ id: string; title?: string; phase?: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(taskId);
    expect(tasks[0]?.title).toBe("Add a widget");
    expect(tasks[0]?.phase).toBe("scoping");
  });

  it("returns 404 for tasks of an unknown project id", async () => {
    const res = await fetch(url("/api/projects/does-not-exist/tasks"), { headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(res.status).toBe(404);
  });
});
