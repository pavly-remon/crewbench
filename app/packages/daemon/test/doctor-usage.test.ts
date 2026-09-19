import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, dispatchRole, makeTaskId, type DispatchParams } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo, waitForTaskKnown } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "agents");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");
const DEVELOPER_SCHEMA = join(REPO_ROOT, "schemas", "developer.json");

describe("daemon doctor + usage routes", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-doctor-home-"));
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
  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${daemon.token}` };
  }

  it("GET /api/doctor returns a real report for all four CLIs and serves a cached copy on the next call", async () => {
    const first = await fetch(url("/api/doctor"), { headers: authHeaders() });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { reports: Array<{ cli: string }>; checked_at: string };
    expect(firstBody.reports.map((r) => r.cli).sort()).toEqual(["agy", "claude", "codex", "copilot"]);

    const second = await fetch(url("/api/doctor"), { headers: authHeaders() });
    const secondBody = (await second.json()) as { checked_at: string };
    // Same checked_at -- the second call was served from the cache, not
    // re-run (each adapter's doctor() makes real network/auth calls, so
    // this is the behavior actually worth asserting, not just "returns
    // 200 twice").
    expect(secondBody.checked_at).toBe(firstBody.checked_at);

    const refreshed = await fetch(url("/api/doctor?refresh=1"), { headers: authHeaders() });
    const refreshedBody = (await refreshed.json()) as { checked_at: string };
    expect(Date.parse(refreshedBody.checked_at)).toBeGreaterThanOrEqual(Date.parse(firstBody.checked_at));
  }, 30_000);

  it("GET /api/projects/:pid/usage returns per-task, per-role usage rollups from real dispatched runs", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    const repo = await gitRepo("crewbench-usage-");
    const addRes = await fetch(url("/api/projects"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo }),
    });
    const project = (await addRes.json()) as { id: string };

    const taskId = makeTaskId("usage check");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Usage check" });
    await waitForTaskKnown(url(""), daemon.token, taskId);

    const params: DispatchParams = {
      role: "developer",
      cli: "claude",
      model: "m",
      effort: "none",
      permissions: "safe",
      taskDir,
      round: 1,
      cwd: repo,
      handoff: "Task: anything\n",
      agentsDir: AGENTS_DIR,
      schemaPath: DEVELOPER_SCHEMA,
      timeoutS: 15,
    };
    await dispatchRole(params);

    const res = await fetch(url(`/api/projects/${project.id}/usage`), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ task_id: string; title: string; usage: Record<string, { runs: number }> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.task_id).toBe(taskId);
    expect(rows[0]?.usage.developer?.runs).toBe(1);
  }, 20_000);

  it("returns 404 for usage of an unknown project", async () => {
    const res = await fetch(url("/api/projects/does-not-exist/usage"), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});
