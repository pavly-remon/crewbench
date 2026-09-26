import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

describe("task-directory cleanup: GET .../cleanup-candidates, POST /api/tasks/:tid/delete", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };
  // Real, pre-existing isolation gap this repo has been bitten by three
  // times this phase (see fs-browse.test.ts's own comment for the full
  // story) -- every daemon test isolates CREWBENCH_HOME from the first
  // line, no exceptions.
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-taskcleanup-home-"));
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

  async function backdate(repo: string, taskId: string, days: number): Promise<void> {
    const stamp = new Date(Date.now() - days * 86_400_000).toISOString();
    const statePath = join(repo, ".crewbench", "tasks", taskId, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
    state.updated_at = stamp;
    await writeFile(statePath, JSON.stringify(state), "utf-8");
    const indexPath = join(repo, ".crewbench", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf-8")) as Record<string, Record<string, unknown>>;
    index[taskId]!.updated_at = stamp;
    await writeFile(indexPath, JSON.stringify(index), "utf-8");
  }

  async function createAppTask(headers: Record<string, string>, repo: string, phase: string, ageDays: number): Promise<string> {
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: `task in ${phase}` }),
    });
    const detail = (await createRes.json()) as { id: string };
    const statePath = join(repo, ".crewbench", "tasks", detail.id, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
    state.phase = phase;
    await writeFile(statePath, JSON.stringify(state), "utf-8");
    const indexPath = join(repo, ".crewbench", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf-8")) as Record<string, Record<string, unknown>>;
    index[detail.id]!.phase = phase;
    await writeFile(indexPath, JSON.stringify(index), "utf-8");
    if (ageDays > 0) await backdate(repo, detail.id, ageDays);
    return detail.id;
  }

  it("lists only finished tasks past the age threshold, excluding an unfinished task regardless of age", async () => {
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-cleanup-list-");
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    const oldDone = await createAppTask(headers, repo, "done", 60);
    await createAppTask(headers, repo, "done", 2); // recent -- excluded
    await createAppTask(headers, repo, "scoping", 90); // old but unfinished -- excluded

    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };

    const res = await fetch(url(`/api/projects/${project.id}/tasks/cleanup-candidates?older_than_days=30`), { headers });
    expect(res.status).toBe(200);
    const candidates = (await res.json()) as Array<{ id: string; age_days: number | null }>;
    expect(candidates.map((c) => c.id)).toEqual([oldDone]);
    expect(candidates[0]!.age_days).toBeGreaterThanOrEqual(60);
  });

  it("deletes a finished task's whole directory and index entry, and it stops being addressable", async () => {
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-cleanup-delete-");
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const taskId = await createAppTask(headers, repo, "stopped", 40);
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    expect(existsSync(taskDir)).toBe(true);

    // /delete takes no body -- deliberately no Content-Type here
    // (task-control.test.ts's own /resume tests hit exactly this: a
    // bodyless POST with Content-Type: application/json makes Fastify's
    // default JSON parser reject the request outright).
    const noBodyHeaders = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url(`/api/tasks/${taskId}/delete`), { method: "POST", headers: noBodyHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: taskId });
    expect(existsSync(taskDir)).toBe(false);

    const getRes = await fetch(url(`/api/tasks/${taskId}`), { headers });
    expect(getRes.status).toBe(404);
  });

  it("refuses to delete a task that isn't genuinely finished, with a real 409, changing nothing", async () => {
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-cleanup-refuse-");
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const taskId = await createAppTask(headers, repo, "implementing", 0);
    const taskDir = join(repo, ".crewbench", "tasks", taskId);

    const noBodyHeaders = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url(`/api/tasks/${taskId}/delete`), { method: "POST", headers: noBodyHeaders });
    expect(res.status).toBe(409);
    expect(existsSync(taskDir)).toBe(true);
  });

  it("404s cleanup-candidates for an unknown project", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/projects/no-such-project/tasks/cleanup-candidates"), { headers });
    expect(res.status).toBe(404);
  });

  /** The real gap review caught: `deleteTask()` alone only reads the
   * on-disk `phase` -- it has no way to know a `driveTask()` loop is
   * still genuinely running. The narrow race is specifically a task
   * whose on-disk `phase` already reads terminal (the loop's own
   * `reduce()` already wrote it) while that same loop is still
   * genuinely mid-flight per `TaskRunner` (writing `events.jsonl`,
   * about to exit) -- an on-disk-phase-only check can't see that at
   * all, by construction, no matter how the test times a real
   * subprocess's own exit. So this test doesn't chase that timing
   * directly: it makes a task genuinely active (a real, still-running
   * developer dispatch, `FAKE_CLI_SLEEP`, same fixture
   * `task-control.test.ts`'s cancel test uses), then writes `state.json`
   * to a terminal phase by hand -- exactly what the *end* of that race
   * window looks like on disk -- and proves the route's own
   * `taskRunner.isActive()` guard still refuses it, deterministically,
   * rather than relying on winning a real timing race. */
  it("refuses to delete a task that's genuinely active per TaskRunner, even when its on-disk phase already reads terminal", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "6";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-cleanup-active-");

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

    // Simulate the exact end-of-race snapshot: still active per
    // TaskRunner (the dispatch above is still genuinely sleeping), but
    // the on-disk phase already says "done" -- what an on-disk-phase-only
    // check would see as "safe to delete."
    const statePath = join(taskDir, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
    state.phase = "done";
    await writeFile(statePath, JSON.stringify(state), "utf-8");

    const noBodyHeaders = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url(`/api/tasks/${detail.id}/delete`), { method: "POST", headers: noBodyHeaders });
    expect(res.status).toBe(409);
    expect(existsSync(taskDir)).toBe(true);

    // Clean up: cancel the still-running dispatch so the daemon can
    // close without a lingering subprocess.
    await fetch(url(`/api/tasks/${detail.id}/cancel`), { method: "POST", headers, body: JSON.stringify({}) });
  }, 15_000);
});
