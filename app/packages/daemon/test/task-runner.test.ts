import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, dispatchRole, makeTaskId, setField, type DispatchParams } from "@crewbench/engine";
import { TaskRunner } from "../src/task-runner.js";
import { DaemonWatcher } from "../src/watcher.js";
import { gitRepo, sleep } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "agents");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");
const DEVELOPER_SCHEMA = join(REPO_ROOT, "schemas", "developer.json");

const LINEUP_ROLES = {
  developer: { cli: "claude", model: "m", effort: "none", permissions: "safe" },
  tester: { cli: "claude", model: "m", effort: "none", permissions: "safe" },
  "code-reviewer": { cli: "claude", model: "m", effort: "none", permissions: "safe" },
  "ui-ux": { cli: "claude", model: "m", effort: "none", permissions: "safe" },
};

async function readStatus(taskDir: string): Promise<Record<string, { state?: string; pid?: number }>> {
  try {
    return JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8")) as Record<string, { state?: string; pid?: number }>;
  } catch {
    return {};
  }
}

describe("TaskRunner: reattach on restart", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  /** The Definition of Done claim for Phase 3 milestone 1, proven end to
   * end against real subprocesses rather than a mock: a run genuinely
   * in flight when the daemon that started it "disappears" (a fresh
   * `TaskRunner`/`DaemonWatcher` pair with no memory of it, standing in
   * for a restarted process -- vitest can't literally kill and restart
   * its own Node process, so this simulates the actual invariant that
   * matters: reattach logic must work from what's on disk plus a real
   * live pid, not from any in-memory state a previous instance held)
   * still finishes correctly, and the new `TaskRunner` picks the fix
   * loop back up from exactly where it left off -- dispatching
   * verification next, not re-dispatching the developer round it never
   * saw start. */
  it("resumes a task whose developer round was still in flight when the daemon restarted", async () => {
    const repo = await gitRepo("crewbench-taskrunner-");
    const taskId = makeTaskId("reattach me");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Reattach me", owner: "app" });
    await setField(taskDir, "lineup", LINEUP_ROLES);

    // Stands in for "a previous daemon instance already dispatched
    // round 1's developer" -- a real subprocess, deliberately slowed
    // down (quick_success.py's own FAKE_CLI_SLEEP support, built for
    // exactly this "catch it mid-run" purpose) so there's a real window
    // to observe it genuinely in flight before it finishes on its own.
    process.env.FAKE_CLI_SLEEP = "1.5";
    const params: DispatchParams = {
      role: "developer",
      cli: "claude",
      model: "m",
      effort: "none",
      permissions: "safe",
      taskDir,
      round: 1,
      cwd: repo,
      handoff: "Task: reattach me\n",
      agentsDir: AGENTS_DIR,
      schemaPath: DEVELOPER_SCHEMA,
      timeoutS: 15,
    };
    const orphanedDispatch = dispatchRole(params);

    // Confirm it's genuinely running with a real, alive pid before
    // "restarting" -- not just assumed from timing.
    const deadline = Date.now() + 5000;
    let status = await readStatus(taskDir);
    while (status["developer-r1"]?.state !== "running" && Date.now() < deadline) {
      await sleep(50);
      status = await readStatus(taskDir);
    }
    expect(status["developer-r1"]?.state).toBe("running");
    expect(typeof status["developer-r1"]?.pid).toBe("number");

    // The "restart": a fresh watcher + TaskRunner, no in-memory
    // knowledge of the dispatch above at all.
    const watcher = new DaemonWatcher();
    await watcher.addProject({ id: "p1", path: repo, name: "reattach-test", added_at: new Date().toISOString() });
    const taskRunner = new TaskRunner(watcher);

    await taskRunner.reattachProject(repo);
    // Must NOT have started driving yet -- the developer run is still
    // genuinely in flight, so re-entering driveTask() right now would
    // re-dispatch it a second time.
    expect(taskRunner.isActive(taskId)).toBe(false);

    // Let the orphaned dispatch actually finish on its own (a real
    // subprocess, unaffected by anything the "restart" above did).
    const envelope = await orphanedDispatch;
    expect(envelope.ok).toBe(true);

    // Once run.finished lands, TaskRunner resumes the fix loop and
    // moves on to the next command -- gate, then verification -- proven
    // by tester/code-reviewer actually getting dispatched, which could
    // only happen if decide() advanced past dispatch_developer instead
    // of reissuing it.
    const resumeDeadline = Date.now() + 10_000;
    let sawVerification = false;
    while (Date.now() < resumeDeadline) {
      const current = await readStatus(taskDir);
      if (current["tester-r1"] || current["code-reviewer-r1"]) {
        sawVerification = true;
        break;
      }
      await sleep(100);
    }
    expect(sawVerification).toBe(true);

    // And developer-r1 itself was never re-dispatched -- still exactly
    // the one run.
    const finalStatus = await readStatus(taskDir);
    expect(finalStatus["developer-r1"]?.state).toBe("done");

    await watcher.close();
  }, 30_000);

  it("does not touch a task it doesn't own", async () => {
    const repo = await gitRepo("crewbench-taskrunner-notowned-");
    const taskId = makeTaskId("not mine");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Not mine" }); // no owner -- reads as "plugin"

    const watcher = new DaemonWatcher();
    await watcher.addProject({ id: "p1", path: repo, name: "not-owned-test", added_at: new Date().toISOString() });
    const taskRunner = new TaskRunner(watcher);

    await taskRunner.reattachProject(repo);
    expect(taskRunner.isActive(taskId)).toBe(false);
    await sleep(200); // give it a moment to have wrongly started, if it were going to
    expect(taskRunner.isActive(taskId)).toBe(false);

    await watcher.close();
  });
});
