import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask } from "../src/task-store.js";
import { reconcileDeadRuns, rehydrateState } from "../src/resume.js";
import { atomicWriteJson } from "../src/contract-fs.js";

async function newTaskDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crewbench-resume-"));
  return join(root, ".crewbench", "tasks", "t1");
}

describe("reconcileDeadRuns", () => {
  it("marks a run failed when its pid is no longer alive", async () => {
    const taskDir = await newTaskDir();
    await mkdir(join(taskDir, "runs"), { recursive: true });
    // A pid essentially guaranteed to be dead: max pid_t on a 32-bit
    // system is well above any real process count on any test runner.
    const deadPid = 2_147_483_647;
    await atomicWriteJson(join(taskDir, "runs", "status.json"), {
      "developer-r1": { state: "running", pid: deadPid },
    });
    const dead = await reconcileDeadRuns(taskDir);
    expect(dead).toEqual(["developer-r1"]);
    const status = JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8"));
    expect(status["developer-r1"].state).toBe("failed");
  });

  it("leaves a live process's run alone", async () => {
    const taskDir = await newTaskDir();
    await mkdir(join(taskDir, "runs"), { recursive: true });
    await atomicWriteJson(join(taskDir, "runs", "status.json"), {
      "developer-r1": { state: "running", pid: process.pid }, // definitely alive: it's us
    });
    const dead = await reconcileDeadRuns(taskDir);
    expect(dead).toEqual([]);
    const status = JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8"));
    expect(status["developer-r1"].state).toBe("running");
  });

  it("ignores a run that's already done/failed", async () => {
    const taskDir = await newTaskDir();
    await mkdir(join(taskDir, "runs"), { recursive: true });
    await atomicWriteJson(join(taskDir, "runs", "status.json"), {
      "developer-r1": { state: "done", pid: 2_147_483_647 },
    });
    expect(await reconcileDeadRuns(taskDir)).toEqual([]);
  });

  it("returns an empty list when status.json doesn't exist", async () => {
    const taskDir = await newTaskDir();
    expect(await reconcileDeadRuns(taskDir)).toEqual([]);
  });
});

const LOOP = { maxRounds: 3, fixThreshold: "major" as const };

async function writeEnvelope(taskDir: string, name: string, result: unknown, ok = true): Promise<void> {
  await mkdir(join(taskDir, "runs"), { recursive: true });
  await writeFile(join(taskDir, "runs", `${name}.result.json`), JSON.stringify({ ok, result }), "utf-8");
}

describe("rehydrateState", () => {
  it("rehydrates a task with no runs yet back to the start", async () => {
    const taskDir = await newTaskDir();
    await createTask(taskDir, { id: "t1", command: "new-task", title: "T" });
    const state = await rehydrateState(taskDir, LOOP);
    expect(state.phase).toBe("implementing");
    expect(state.round).toBe(1);
    expect(state.rounds).toEqual([]);
  });

  it("rehydrates a task that finished round 1 cleanly (awaiting_commit)", async () => {
    const taskDir = await newTaskDir();
    await createTask(taskDir, { id: "t1", command: "new-task", title: "T" });
    await writeEnvelope(taskDir, "developer-r1", { status: "done", summary: "x", files_changed: [], assumptions: [], questions: [], blocked: [] });
    await writeFile(join(taskDir, "runs", "gate-r1.result.json"), JSON.stringify({ ok: true, steps: [] }), "utf-8");
    await writeEnvelope(taskDir, "tester-r1", { verdict: "pass", summary: "ok", tests_run: [], tests_added: [], failures: [], blocked: [] });
    await writeEnvelope(taskDir, "code-reviewer-r1", { verdict: "approve", summary: "ok", issues: [], blocked: [] });

    const state = await rehydrateState(taskDir, LOOP);
    expect(state.phase).toBe("awaiting_commit");
    expect(state.rounds).toHaveLength(1);
  });

  it("rehydrates a task stuck in a fix loop, rebuilding the issue registry", async () => {
    const taskDir = await newTaskDir();
    await createTask(taskDir, { id: "t1", command: "new-task", title: "T" });
    // Round 1: gate passes, reviewer finds a major issue -> round 2.
    await writeEnvelope(taskDir, "developer-r1", { status: "done", summary: "x", files_changed: [], assumptions: [], questions: [], blocked: [] });
    await writeFile(join(taskDir, "runs", "gate-r1.result.json"), JSON.stringify({ ok: true, steps: [] }), "utf-8");
    await writeEnvelope(taskDir, "tester-r1", { verdict: "pass", summary: "ok", tests_run: [], tests_added: [], failures: [], blocked: [] });
    await writeEnvelope(taskDir, "code-reviewer-r1", {
      verdict: "changes_requested",
      summary: "issue found",
      issues: [{ id: "R1-1", file: "a.ts", line: 1, severity: "major", category: "correctness", change: "fix it" }],
      blocked: [],
    });
    await import("../src/task-store.js").then((m) => m.setField(taskDir, "round", 2));

    const state = await rehydrateState(taskDir, LOOP);
    expect(state.phase).toBe("fixing");
    expect(state.round).toBe(2);
    expect(state.issueRegistry).toHaveLength(1);
    expect(state.issueRegistry[0]).toMatchObject({ id: "R1-1", status: "open" });
  });

  it("stops replaying at the first round with no developer result recorded", async () => {
    const taskDir = await newTaskDir();
    await createTask(taskDir, { id: "t1", command: "new-task", title: "T" });
    // No runs/*.result.json at all -- state.json.round may say something,
    // but nothing was actually recorded, so replay must not crash.
    const state = await rehydrateState(taskDir, LOOP);
    expect(state.phase).toBe("implementing");
    expect(state.rounds).toEqual([]);
  });

  it("rehydrates a gate-failure round correctly (no verification that round)", async () => {
    const taskDir = await newTaskDir();
    await createTask(taskDir, { id: "t1", command: "new-task", title: "T" });
    await writeEnvelope(taskDir, "developer-r1", { status: "done", summary: "x", files_changed: [], assumptions: [], questions: [], blocked: [] });
    await writeFile(
      join(taskDir, "runs", "gate-r1.result.json"),
      JSON.stringify({ ok: false, steps: [{ name: "lint", command: "eslint .", exit_code: 1, duration_s: 1, timed_out: false, output_tail: "err" }] }),
      "utf-8",
    );

    const state = await rehydrateState(taskDir, LOOP);
    expect(state.phase).toBe("fixing");
    expect(state.round).toBe(2);
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]?.tester).toBeNull();
  });
});
