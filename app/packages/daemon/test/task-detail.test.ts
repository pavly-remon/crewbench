import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, makeTaskId } from "@crewbench/engine";
import { dispatchRole, type DispatchParams } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo, waitForTaskKnown } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "agents");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");
const DEVELOPER_SCHEMA = join(REPO_ROOT, "schemas", "developer.json");

describe("daemon task detail", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-taskdetail-home-"));
    process.env.CREWBENCH_HOME = home;
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
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

  /** Registers a project, creates a real task, and dispatches a real
   * developer round against the same `quick_success.py` fake-CLI fixture
   * Phase 1's own runner tests trust -- writes the real
   * `runs/developer-r1.{result.json,log}` files this milestone's
   * task-detail/log routes actually read, not a hand-written fixture
   * shaped to look like one. */
  async function setUpTaskWithARealRun(): Promise<{ pid: string; taskId: string; taskDir: string; repo: string }> {
    const repo = await gitRepo("crewbench-taskdetail-");
    const addRes = await fetch(url("/api/projects"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo }),
    });
    const project = (await addRes.json()) as { id: string };

    const taskId = makeTaskId("show me the detail");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Show me the detail" });
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
    const envelope = await dispatchRole(params);
    expect(envelope.ok).toBe(true);

    return { pid: project.id, taskId, taskDir, repo };
  }

  it("returns state, rehydrated rounds, and per-role usage for a real dispatched run", async () => {
    const { taskId } = await setUpTaskWithARealRun();

    const res = await fetch(url(`/api/tasks/${taskId}`), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      id: string;
      title: string;
      rounds: unknown[];
      usage: Record<string, { runs: number; cli: string; model: string }>;
    };
    expect(detail.id).toBe(taskId);
    expect(detail.title).toBe("Show me the detail");
    expect(detail.rounds).toHaveLength(0); // developer done, but no gate.finished recorded yet this round
    expect(detail.usage.developer).toMatchObject({ runs: 1, cli: "claude", model: "m" });
  }, 20_000);

  it("returns 404 for an unknown task id", async () => {
    const res = await fetch(url("/api/tasks/does-not-exist"), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("reads a run's log incrementally by byte offset", async () => {
    const { taskId } = await setUpTaskWithARealRun();

    const first = await fetch(url(`/api/tasks/${taskId}/runs/developer-r1/log?from=0`), { headers: authHeaders() });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { text: string; next_offset: number };
    expect(firstBody.text.length).toBeGreaterThan(0);
    expect(firstBody.next_offset).toBe(firstBody.text.length);

    const second = await fetch(url(`/api/tasks/${taskId}/runs/developer-r1/log?from=${firstBody.next_offset}`), {
      headers: authHeaders(),
    });
    const secondBody = (await second.json()) as { text: string; next_offset: number };
    expect(secondBody.text).toBe("");
    expect(secondBody.next_offset).toBe(firstBody.next_offset);
  }, 20_000);

  it("returns 404 for a log request against an unknown run", async () => {
    const { taskId } = await setUpTaskWithARealRun();
    const res = await fetch(url(`/api/tasks/${taskId}/runs/does-not-exist-r1/log`), { headers: authHeaders() });
    expect(res.status).toBe(404);
  }, 20_000);
});
