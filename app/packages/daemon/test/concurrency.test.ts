import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, makeTaskId, setField } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { addProject } from "../src/registry.js";
import { gitRepo, sleep } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");

const LINEUP_ROLES = {
  developer: { cli: "claude", model: "m", effort: "none", permissions: "safe" },
  tester: { cli: "claude", model: "m", effort: "none", permissions: "safe" },
  "code-reviewer": { cli: "claude", model: "m", effort: "none", permissions: "safe" },
  "ui-ux": { cli: "claude", model: "m", effort: "none", permissions: "safe" },
};

async function readStatus(taskDir: string): Promise<Record<string, { state?: string }>> {
  try {
    return JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8")) as Record<string, { state?: string }>;
  } catch {
    return {};
  }
}

/** The Definition of Done claim for Phase 3 milestone 2, proven at the
 * daemon level (not just `packages/engine`'s own unit-shaped test): two
 * real app-owned tasks in *two different projects*, sharing the same CLI
 * under a configured limit of 1 -- matching the phase prompt's own
 * "enforces the per-CLI concurrency limits across all projects and
 * tasks," not just within one project. Both projects are registered
 * before the daemon starts, so `startDaemon()`'s own startup reattach
 * kicks both tasks' `driveTask()` loops off in the same `Promise.all()`,
 * giving the limiter a real, simultaneous pair of claims to serialize. */
describe("TaskRunner: cross-project concurrency (Phase 3 milestone 2)", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "0.4";
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it("serializes two app-owned tasks' developer dispatches across two projects under a configured limit of 1", async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-concurrency-home-"));
    process.env.CREWBENCH_HOME = home;
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ concurrency: { claude: 1 } }), "utf-8");

    const repoA = await gitRepo("crewbench-concurrency-a-");
    const repoB = await gitRepo("crewbench-concurrency-b-");
    await addProject(repoA, "project-a");
    await addProject(repoB, "project-b");

    const taskIdA = makeTaskId("task a");
    const taskDirA = join(repoA, ".crewbench", "tasks", taskIdA);
    await createTask(taskDirA, { id: taskIdA, command: "new-task", title: "Task A", owner: "app" });
    await setField(taskDirA, "lineup", LINEUP_ROLES);

    const taskIdB = makeTaskId("task b");
    const taskDirB = join(repoB, ".crewbench", "tasks", taskIdB);
    await createTask(taskDirB, { id: taskIdB, command: "new-task", title: "Task B", owner: "app" });
    await setField(taskDirB, "lineup", LINEUP_ROLES);

    const start = Date.now();
    daemon = await startDaemon({ port: 0 }); // starts driving both tasks' developer-r1 as part of its own startup reattach

    // Wait until both developer-r1 runs have finished.
    const deadline = Date.now() + 15_000;
    let doneA = false;
    let doneB = false;
    while (Date.now() < deadline && !(doneA && doneB)) {
      const [statusA, statusB] = await Promise.all([readStatus(taskDirA), readStatus(taskDirB)]);
      doneA = statusA["developer-r1"]?.state === "done";
      doneB = statusB["developer-r1"]?.state === "done";
      if (!(doneA && doneB)) await sleep(50);
    }
    const elapsedS = (Date.now() - start) / 1000;
    expect(doneA).toBe(true);
    expect(doneB).toBe(true);
    // A soft sanity bound, not the primary proof (real setup overhead --
    // reconcileDeadRuns()/rehydrateState()/prompt building, all
    // *outside* the limiter's gate -- means this doesn't cleanly double
    // the ~0.4s sleep; observed ~0.6s in practice). The real proof that
    // the limiter actually engaged is the run.queued event below, not a
    // wall-clock threshold.
    expect(elapsedS).toBeGreaterThan(0.4);

    // At least one of the two tasks actually had to wait for a slot --
    // proven by a real run.queued event on its own events.jsonl
    // (whichever task lost the race to claim the single slot first).
    // This is the real signal a limit of 1 across two projects actually
    // did something, not just a timing coincidence.
    const [eventsA, eventsB] = await Promise.all([
      readFile(join(taskDirA, "events.jsonl"), "utf-8").catch(() => ""),
      readFile(join(taskDirB, "events.jsonl"), "utf-8").catch(() => ""),
    ]);
    const sawQueued = eventsA.includes('"run.queued"') || eventsB.includes('"run.queued"');
    expect(sawQueued).toBe(true);
  }, 20_000);
});
