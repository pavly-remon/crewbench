import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTask, dispatchRole, makeTaskId, type DispatchParams } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "@crewbench/daemon";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "agents");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");
const DEVELOPER_SCHEMA = join(REPO_ROOT, "schemas", "developer.json");

export interface FixtureInfo {
  port: number;
  token: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
}

/** Starts a real daemon (not a mock) against a fresh `CREWBENCH_HOME`,
 * registers a real fixture git repo as a project, creates a real task,
 * and dispatches one real developer round against the same
 * `quick_success.py` fixture the rest of this repo's test suites trust
 * -- the Definition of Done's "one Playwright smoke test... against a
 * fixture project" is meant to exercise the real board -> task detail
 * path, so the fixture data behind it is real daemon/engine output, not
 * hand-written JSON shaped to look like it. */
export async function startFixtureDaemon(): Promise<{ daemon: DaemonHandle; fixture: FixtureInfo }> {
  const home = await mkdtemp(join(tmpdir(), "crewbench-e2e-home-"));
  process.env.CREWBENCH_HOME = home;
  process.env.CREWBENCH_UI_DIST = resolve(__dirname, "..", "dist");
  process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;

  const repo = await mkdtemp(join(tmpdir(), "crewbench-e2e-repo-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "e2e@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "E2E"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "hello\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  const daemon = await startDaemon({ port: 0 });

  const addRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: repo, name: "e2e-fixture" }),
  });
  const project = (await addRes.json()) as { id: string };

  const taskTitle = "Add a reverse() helper";
  const taskId = makeTaskId(taskTitle);
  const taskDir = join(repo, ".crewbench", "tasks", taskId);
  await createTask(taskDir, { id: taskId, command: "new-task", title: taskTitle });

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

  // Give the watcher a moment to index the new task before any test
  // navigates to a page that depends on it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tasks/${taskId}/events`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    res.body?.cancel().catch(() => {});
    if (res.status !== 404) break;
    if (Date.now() > deadline) throw new Error("fixture task was never indexed by the daemon's watcher");
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    daemon,
    fixture: { port: daemon.port, token: daemon.token, projectId: project.id, taskId, taskTitle },
  };
}

export async function writeFixtureFile(path: string, fixture: FixtureInfo): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(fixture, null, 2), "utf-8");
}
