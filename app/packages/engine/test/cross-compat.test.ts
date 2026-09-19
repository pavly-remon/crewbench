import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTask, loadState, setField } from "../src/task-store.js";
import { rehydrateState } from "../src/resume.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const CREWBENCH_STATE_PY = join(REPO_ROOT, "bin", "crewbench_state.py");

async function runPythonState(args: string[], cwd: string): Promise<unknown> {
  const { stdout } = await execFileAsync("python3", [CREWBENCH_STATE_PY, ...args], { cwd });
  return JSON.parse(stdout);
}

/** The headline requirement of docs/app/phase-1-plan.md's milestone 6:
 * a task created by one side must be readable (and, for state.json,
 * writable) by the other. Both directions are real subprocess/module
 * calls against this machine's actual `python3` and `bin/crewbench_state.py`
 * -- not a simulated/mocked comparison of two in-memory shapes. */
describe("cross-compat: app creates, plugin reads", () => {
  it("crewbench_state.py get sees exactly what task-store.ts wrote", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewbench-xcompat-"));
    const taskDir = join(root, ".crewbench", "tasks", "app-created");
    const state = await createTask(taskDir, { id: "app-created", command: "new-task", title: "Created by the TS engine", jiraKey: "PROJ-1" });
    await setField(taskDir, "phase", "implementing");

    const pythonState = await runPythonState(["get", "--task-dir", taskDir], root);
    expect(pythonState).toMatchObject({
      id: "app-created",
      command: "new-task",
      title: "Created by the TS engine",
      jira_key: "PROJ-1",
      phase: "implementing",
      schema_version: state.schema_version,
    });
  });

  it("crewbench_state.py list sees it in index.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewbench-xcompat-"));
    const crewbenchDir = join(root, ".crewbench");
    await createTask(join(crewbenchDir, "tasks", "app-created-2"), { id: "app-created-2", command: "review", title: "Listed task" });

    const rows = (await runPythonState(["list", "--root", crewbenchDir], root)) as { id: string; title: string }[];
    expect(rows.some((r) => r.id === "app-created-2" && r.title === "Listed task")).toBe(true);
  });

  it("crewbench_state.py set can further mutate a task the app created", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewbench-xcompat-"));
    const taskDir = join(root, ".crewbench", "tasks", "app-created-3");
    await createTask(taskDir, { id: "app-created-3", command: "new-task", title: "T" });

    await runPythonState(["set", "--task-dir", taskDir, "--key", "phase", "--value", '"verifying"'], root);
    const state = await loadState(taskDir);
    expect(state.phase).toBe("verifying");
  });
});

describe("cross-compat: plugin creates, app reads and rehydrates", () => {
  it("loadState() reads a state.json crewbench_state.py new wrote", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewbench-xcompat-"));
    const taskDir = join(root, ".crewbench", "tasks", "plugin-created");
    await runPythonState(["new", "--task-dir", taskDir, "--id", "plugin-created", "--command", "new-task", "--title", "Created by the plugin"], root);

    const state = await loadState(taskDir);
    expect(state.id).toBe("plugin-created");
    expect(state.title).toBe("Created by the plugin");
    expect(state.phase).toBe("scoping");
    expect(state.schema_version).toBe(1);
  });

  it("rehydrateState() replays a plugin-created task's round history correctly", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewbench-xcompat-"));
    const taskDir = join(root, ".crewbench", "tasks", "plugin-created-2");
    await runPythonState(
      ["new", "--task-dir", taskDir, "--id", "plugin-created-2", "--command", "new-task", "--title", "T"],
      root,
    );
    await runPythonState(["set", "--task-dir", taskDir, "--key", "phase", "--value", '"fixing"'], root);
    await runPythonState(["set", "--task-dir", taskDir, "--key", "round", "--value", "2"], root);

    // Simulate the plugin's own runs/ artifacts (written by
    // crewbench_dispatch.py in real use) -- same file family, same shape,
    // so rehydrateState() reads them exactly as it would for an
    // app-created task.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(taskDir, "runs"), { recursive: true });
    await writeFile(
      join(taskDir, "runs", "developer-r1.result.json"),
      JSON.stringify({ ok: true, result: { status: "done", summary: "x", files_changed: [], assumptions: [], questions: [], blocked: [] } }),
      "utf-8",
    );
    await writeFile(join(taskDir, "runs", "gate-r1.result.json"), JSON.stringify({ ok: true, steps: [] }), "utf-8");
    await writeFile(
      join(taskDir, "runs", "tester-r1.result.json"),
      JSON.stringify({ ok: true, result: { verdict: "pass", summary: "ok", tests_run: [], tests_added: [], failures: [], blocked: [] } }),
      "utf-8",
    );
    await writeFile(
      join(taskDir, "runs", "code-reviewer-r1.result.json"),
      JSON.stringify({
        ok: true,
        result: {
          verdict: "changes_requested",
          summary: "one issue",
          issues: [{ id: "R1-1", file: "a.ts", line: 1, severity: "major", category: "correctness", change: "fix" }],
          blocked: [],
        },
      }),
      "utf-8",
    );

    const state = await rehydrateState(taskDir, { maxRounds: 3, fixThreshold: "major" });
    expect(state.phase).toBe("fixing");
    expect(state.round).toBe(2);
    expect(state.issueRegistry).toHaveLength(1);
    expect(state.issueRegistry[0]).toMatchObject({ id: "R1-1", status: "open" });

    // And the reverse check: the plugin's own reader still parses the
    // state.json untouched by any of this (the app never had to write to
    // it to rehydrate in-memory state).
    const pythonState = await runPythonState(["get", "--task-dir", taskDir], root);
    expect(pythonState).toMatchObject({ phase: "fixing", round: 2 });
  });
});
