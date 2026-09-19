import { execFile } from "node:child_process";
import { join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, makeTaskId } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo, waitForTaskKnown } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("daemon diff + screenshots routes", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-diff-home-"));
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

  async function registerProjectAndTask(baseCommit: string | null, repo: string): Promise<{ taskId: string; taskDir: string }> {
    await fetch(url("/api/projects"), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo }),
    });
    const taskId = makeTaskId("diff me");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Diff me", baseCommit });
    await waitForTaskKnown(url(""), daemon.token, taskId);
    return { taskId, taskDir };
  }

  it("computes a real git diff against base_commit, from real uncommitted changes in the repo", async () => {
    const repo = await gitRepo("crewbench-diff-");
    const { stdout: baseCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
    const { taskId } = await registerProjectAndTask(baseCommit.trim(), repo);

    // A real, uncommitted change in the repo's working tree -- exactly
    // what an in-progress task's developer round would leave behind.
    await writeFile(join(repo, "a.txt"), "hello\nworld\n");

    const res = await fetch(url(`/api/tasks/${taskId}/diff?round=base`), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; round: number | null; diff: string };
    expect(body.mode).toBe("base");
    expect(body.round).toBeNull();
    expect(body.diff).toContain("a.txt");
    expect(body.diff).toContain("+world");
  });

  it("round=N returns the same diff as base, honestly labeled (no round-scoped snapshots exist)", async () => {
    const repo = await gitRepo("crewbench-diff-");
    const { stdout: baseCommit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
    const { taskId } = await registerProjectAndTask(baseCommit.trim(), repo);
    await writeFile(join(repo, "a.txt"), "changed\n");

    const baseRes = await fetch(url(`/api/tasks/${taskId}/diff?round=base`), { headers: authHeaders() });
    const roundRes = await fetch(url(`/api/tasks/${taskId}/diff?round=2`), { headers: authHeaders() });
    const baseBody = (await baseRes.json()) as { mode: string; diff: string };
    const roundBody = (await roundRes.json()) as { mode: string; round: number; diff: string };
    expect(roundBody.mode).toBe("round");
    expect(roundBody.round).toBe(2);
    expect(roundBody.diff).toBe(baseBody.diff);
  });

  it("returns an empty diff when the task has no recorded base_commit", async () => {
    const repo = await gitRepo("crewbench-diff-");
    const { taskId } = await registerProjectAndTask(null, repo);
    const res = await fetch(url(`/api/tasks/${taskId}/diff`), { headers: authHeaders() });
    const body = (await res.json()) as { diff: string };
    expect(body.diff).toBe("");
  });

  it("serves a real screenshot file with the right content type", async () => {
    const repo = await gitRepo("crewbench-diff-");
    const { taskId, taskDir } = await registerProjectAndTask("HEAD", repo);
    const shotsDir = join(taskDir, "screenshots");
    await mkdir(shotsDir, { recursive: true });
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex"); // real PNG magic bytes
    await writeFile(join(shotsDir, "round1.png"), pngBytes);

    const res = await fetch(url(`/api/tasks/${taskId}/screenshots/round1.png`), { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(pngBytes)).toBe(true);
  });

  it("rejects a path-traversal attempt and an unsupported extension", async () => {
    const repo = await gitRepo("crewbench-diff-");
    const { taskId } = await registerProjectAndTask("HEAD", repo);

    const traversal = await fetch(url(`/api/tasks/${taskId}/screenshots/..%2F..%2Fa.txt`), { headers: authHeaders() });
    expect(traversal.status).toBe(400); // basename() strips it down to "a.txt", refused for its extension either way

    const badExt = await fetch(url(`/api/tasks/${taskId}/screenshots/notes.txt`), { headers: authHeaders() });
    expect(badExt.status).toBe(400);
  });

  it("returns 404 for a screenshot that doesn't exist", async () => {
    const repo = await gitRepo("crewbench-diff-");
    const { taskId } = await registerProjectAndTask("HEAD", repo);
    const res = await fetch(url(`/api/tasks/${taskId}/screenshots/missing.png`), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});
