import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo, sleep } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");

const VALID_SPEC = {
  title: "Add a reverse function",
  description: "Add a function reverse(str) in src/reverse.js.",
  acceptance_criteria: ["reverse('abc') returns 'cba'"],
  affected_areas: [],
  out_of_scope: [],
  needs_design: false,
  constraints: [],
};

const LINEUP_BODY = {
  roles: {
    developer: { cli: "claude", model: "m", effort: "none", permissions: "safe" },
    tester: { cli: "claude", model: "m", effort: "none", permissions: "safe" },
    "code-reviewer": { cli: "claude", model: "m", effort: "none", permissions: "safe" },
    "ui-ux": { cli: "claude", model: "m", effort: "none", permissions: "safe" },
  },
};

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(100);
  }
}

describe("DELETE /api/projects/:pid", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-projects-delete-home-"));
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

  it("removes a project with no active tasks", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-projects-delete-idle-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };

    const delRes = await fetch(url(`/api/projects/${project.id}`), { method: "DELETE", headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(delRes.status).toBe(204);

    const listRes = await fetch(url("/api/projects"), { headers });
    const projects = (await listRes.json()) as Array<{ id: string }>;
    expect(projects.some((p) => p.id === project.id)).toBe(false);
  });

  /** The real gap review caught: removing a project used to just
   * unregister it and stop the watcher, even while one of its app-owned
   * tasks was still genuinely being driven by this daemon's own
   * `TaskRunner` -- the loop kept running, mutating files under a
   * project the daemon no longer had any addressable state/SSE route
   * for. Proven here with a real, still-in-flight subprocess
   * (`FAKE_CLI_SLEEP`, the same fixture `task-control.test.ts`'s cancel
   * test and `task-cleanup.test.ts`'s own active-task test use), not a
   * mocked `isActive()`. */
  it("refuses to remove a project with a task the daemon is genuinely still driving", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "6";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-projects-delete-active-");

    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "Add a reverse function" }),
    });
    const detail = (await createRes.json()) as { id: string };
    await fetch(url(`/api/tasks/${detail.id}/scoping/finalize`), { method: "POST", headers, body: JSON.stringify(VALID_SPEC) });
    const lineupRes = await fetch(url(`/api/tasks/${detail.id}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(lineupRes.status).toBe(200);
    const taskDir = join(repo, ".crewbench", "tasks", detail.id);

    await waitFor(async () => {
      const status = JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8").catch(() => "{}")) as Record<
        string,
        { state?: string; pid?: number }
      >;
      return status["developer-r1"]?.state === "running" && typeof status["developer-r1"]?.pid === "number";
    });

    const delRes = await fetch(url(`/api/projects/${project.id}`), { method: "DELETE", headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(delRes.status).toBe(409);

    // The project is still registered -- a real refusal, not a partial removal.
    const listRes = await fetch(url("/api/projects"), { headers });
    const projects = (await listRes.json()) as Array<{ id: string }>;
    expect(projects.some((p) => p.id === project.id)).toBe(true);

    await fetch(url(`/api/tasks/${detail.id}/cancel`), { method: "POST", headers, body: JSON.stringify({}) });
  }, 15_000);

  it("404s for an unknown project", async () => {
    daemon = await startDaemon({ port: 0 });
    const res = await fetch(url("/api/projects/no-such-project"), { method: "DELETE", headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(res.status).toBe(404);
  });
});
