import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, makeTaskId } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo, sleep, waitForTaskKnown } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");

const VALID_SPEC = {
  title: "Fix login redirect",
  description: "Redirects to the wrong page after login.",
  acceptance_criteria: ["Redirects to /dashboard"],
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

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(100);
  }
}

describe("POST /api/tasks/:tid/lineup (Phase 3 milestone 4)", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-lineup-home-"));
    process.env.CREWBENCH_HOME = home;
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }

  async function createAndFinalizeTask(headers: Record<string, string>): Promise<{ pid: string; taskId: string; repo: string }> {
    const repo = await gitRepo("crewbench-lineup-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };

    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "Fix the login redirect bug" }),
    });
    const detail = (await createRes.json()) as { id: string };

    const finalizeRes = await fetch(url(`/api/tasks/${detail.id}/scoping/finalize`), {
      method: "POST",
      headers,
      body: JSON.stringify(VALID_SPEC),
    });
    expect(finalizeRes.status).toBe(200);

    return { pid: project.id, taskId: detail.id, repo };
  }

  it("writes the lineup, genuinely starts the task, and a real developer round actually dispatches", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const { taskId, repo } = await createAndFinalizeTask(headers);

    const res = await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { lineup: Record<string, unknown> };
    expect(detail.lineup.developer).toMatchObject({ cli: "claude", model: "m" });

    // The actual claim: this genuinely started driveTask(), which
    // genuinely dispatched a real developer subprocess -- not just wrote
    // JSON. Proven by the real result file quick_success.py's own
    // dispatch produces, not by inspecting in-memory state.
    const resultPath = join(repo, ".crewbench", "tasks", taskId, "runs", "developer-r1.result.json");
    await waitFor(async () => {
      try {
        const envelope = JSON.parse(await readFile(resultPath, "utf-8")) as { ok: boolean };
        return envelope.ok === true;
      } catch {
        return false;
      }
    });

    const stateOnDisk = JSON.parse(
      await readFile(join(repo, ".crewbench", "tasks", taskId, "state.json"), "utf-8"),
    ) as { phase: string };
    expect(stateOnDisk.phase).not.toBe("scoping"); // driveTask() actually advanced it
  }, 15_000);

  it("save_as_default merges the submitted roles into a real team.json", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const { pid, taskId, repo } = await createAndFinalizeTask(headers);

    const res = await fetch(url(`/api/tasks/${taskId}/lineup`), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...LINEUP_BODY, save_as_default: true }),
    });
    expect(res.status).toBe(200);

    const team = JSON.parse(await readFile(join(repo, ".crewbench", "team.json"), "utf-8"));
    expect(team.roles.developer).toMatchObject({ cli: "claude", model: "m" });

    const teamRes = await fetch(url(`/api/projects/${pid}/team`), { headers });
    expect(teamRes.status).toBe(200);
    const teamBody = (await teamRes.json()) as { roles: { developer: { cli: string } } };
    expect(teamBody.roles.developer.cli).toBe("claude");
  });

  it("400s if scoping hasn't been finalized yet (no spec_file)", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-lineup-nospec-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "no spec yet" }),
    });
    const detail = (await createRes.json()) as { id: string };

    const res = await fetch(url(`/api/tasks/${detail.id}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(res.status).toBe(400);
  });

  it("400s on a second lineup submission -- a task can only be started once", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const { taskId } = await createAndFinalizeTask(headers);

    const first = await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(first.status).toBe(200);

    const second = await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(second.status).toBe(400);
  });

  it("two genuinely concurrent lineup submissions for the same task never both start a driveTask() loop", async () => {
    // Real, disclosed race caught by review (TaskRunner's own
    // `TaskAlreadyStartingError` docstring has the full story): this
    // route's own `hasLineup` check and `taskRunner.startTask()` call
    // aren't atomic with each other, so two truly concurrent requests
    // (fired together via Promise.all, not sequential awaits like the
    // test above) can both pass `hasLineup === false` before either one
    // finishes writing the lineup. The actual claim proven here isn't
    // "the second request 400s" (both might legitimately see an empty
    // lineup and both proceed past that check) -- it's that
    // `TaskRunner`'s own synchronous reservation still stops a second
    // `driveTask()` loop from ever starting: exactly one of the two
    // responses reports a real, successful start (`200`), the other is
    // either the route's own pre-existing `400` (lost the `hasLineup`
    // race) or the new `409` (lost `TaskRunner`'s own reservation race)
    // -- never two `200`s, and never a crash.
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const { taskId } = await createAndFinalizeTask(headers);

    const [a, b] = await Promise.all([
      fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) }),
      fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y); // ascending numeric, not the default lexicographic sort
    expect(statuses[0]).toBe(200); // the winner: genuinely started
    expect(statuses[1]).toBeGreaterThanOrEqual(400); // the loser: 400 (hasLineup) or 409 (TaskAlreadyStartingError)
    expect(statuses[1]).toBeLessThan(500); // never an unhandled crash

    // The actual harm this test guards against: only one driveTask()
    // loop, ever, over this task's own directory -- proven by TaskRunner's
    // own live state, not inferred from the HTTP responses alone.
    expect(daemon.taskRunner.isActive(taskId)).toBe(true);
  }, 15_000);

  it("400s a lineup submission missing a role -- z.record over an enum requires every key", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const { taskId } = await createAndFinalizeTask(headers);

    const { "ui-ux": _dropped, ...incompleteRoles } = LINEUP_BODY.roles;
    void _dropped;
    const res = await fetch(url(`/api/tasks/${taskId}/lineup`), {
      method: "POST",
      headers,
      body: JSON.stringify({ roles: incompleteRoles }),
    });
    expect(res.status).toBe(400);
  });

  it("403s for a plugin-owned task (no owner field)", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-lineup-plugin-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };

    const taskId = makeTaskId("plugin task");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Plugin task" }); // no owner -- plugin-created
    await waitForTaskKnown(url(""), daemon.token, taskId);

    const res = await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(res.status).toBe(403);
    void project;
  }, 15_000);

  // Regression: the real, live bug found while building this milestone
  // (see task-runner.ts's reattachProject() comment) -- before the fix,
  // restarting the daemon while a task was still in "scoping" (no
  // lineup yet, e.g. mid-scoping-chat or waiting on the lineup step)
  // would incorrectly try to drive it: rehydrateState()'s unconditional
  // {type:"start"} reduce got persisted to state.json's phase by
  // driveTask()'s own first lines, before it crashed reading
  // lineup.roles.developer off an empty lineup.
  it("does not corrupt or attempt to drive a lineup-less task across a daemon restart", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const { taskId, repo } = await createAndFinalizeTask(headers); // spec finalized, but lineup NOT submitted

    await daemon.close();
    daemon = await startDaemon({ port: 0 }); // reattachProject() runs again here, against the same registry/task
    const headersAfterRestart = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    // Give any (buggy) driveTask() attempt a real window to have crashed
    // or written something -- the old bug's crash happened within a
    // single synchronous-ish tick of startup, well under this.
    await sleep(500);

    const stateOnDisk = JSON.parse(
      await readFile(join(repo, ".crewbench", "tasks", taskId, "state.json"), "utf-8"),
    ) as { phase: string; lineup: Record<string, unknown> };
    expect(stateOnDisk.phase).toBe("scoping"); // untouched, not corrupted to "design"/"implementing"
    expect(stateOnDisk.lineup).toEqual({});

    // The task is still perfectly startable afterward -- the fix skips
    // driving it, it doesn't break it. Needs the fresh token, and needs
    // the restarted daemon's own watcher to have (re-)indexed the task
    // from disk before it's addressable again.
    await waitForTaskKnown(url(""), daemon.token, taskId);
    const res = await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers: headersAfterRestart, body: JSON.stringify(LINEUP_BODY) });
    expect(res.status).toBe(200);
  }, 15_000);
});
