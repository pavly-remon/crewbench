import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGate, stepsToRun } from "../src/gate.js";
import { cancelRun } from "../src/runner.js";

const NODE = process.execPath;

async function writeProjectJson(cwd: string, commands: Record<string, string | null>): Promise<void> {
  await mkdir(join(cwd, ".crewbench"), { recursive: true });
  await writeFile(join(cwd, ".crewbench", "project.json"), JSON.stringify({ commands }), "utf-8");
}

async function newCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "crewbench-gate-"));
}

// Ported from tests/test_gate.py.
describe("runGate", () => {
  it("no commands configured is ok and empty", async () => {
    const cwd = await newCwd();
    await writeProjectJson(cwd, {});
    const taskDir = join(cwd, "task");
    const { result } = await runGate(cwd, taskDir, 1);
    expect(result).toEqual({ ok: true, steps: [] });
    const log = await readFile(join(taskDir, "runs", "gate-r1.log"), "utf-8");
    expect(log).toContain("nothing to run");
  });

  it("runs configured steps in order and passes", async () => {
    const cwd = await newCwd();
    await writeProjectJson(cwd, {
      lint: `${NODE} -e "console.log('lint ok')"`,
      test: `${NODE} -e "console.log('test ok')"`,
    });
    const { result } = await runGate(cwd, join(cwd, "task"), 1);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(["lint", "test"]);
    expect(result.steps.every((s) => s.exit_code === 0)).toBe(true);
  });

  it("prefers test_changed over test", async () => {
    const cwd = await newCwd();
    await writeProjectJson(cwd, {
      test: `${NODE} -e "process.exit(1)"`,
      test_changed: `${NODE} -e "process.exit(0)"`,
    });
    const { result } = await runGate(cwd, join(cwd, "task"), 1);
    expect(result.steps[0]?.name).toBe("test_changed");
    expect(result.steps[0]?.exit_code).toBe(0);
  });

  it("stops at the first failing step", async () => {
    const cwd = await newCwd();
    await writeProjectJson(cwd, {
      format_check: `${NODE} -e "process.exit(1)"`,
      lint: `${NODE} -e "console.log('should not run')"`,
    });
    const { result } = await runGate(cwd, join(cwd, "task"), 1);
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.name)).toEqual(["format_check"]);
  });

  it("captures output_tail on failure", async () => {
    const cwd = await newCwd();
    await writeProjectJson(cwd, { lint: `${NODE} -e "console.log('boom'); process.exit(2)"` });
    const { result } = await runGate(cwd, join(cwd, "task"), 1);
    expect(result.steps[0]?.exit_code).toBe(2);
    expect(result.steps[0]?.output_tail).toContain("boom");
  });

  it.skipIf(platform() === "win32")("a timeout kills the process group and marks it timed_out", async () => {
    const cwd = await newCwd();
    await writeProjectJson(cwd, { lint: `${NODE} -e "setTimeout(() => {}, 30000)"` });
    const { result } = await runGate(cwd, join(cwd, "task"), 1, undefined, 1);
    const step = result.steps[0];
    expect(step?.timed_out).toBe(true);
    expect(step?.exit_code).toBeNull();
    expect(step?.duration_s).toBeLessThan(10);
  }, 15_000);

  it.skipIf(platform() === "win32")(
    "writes a real, killable status.json entry -- cancelRun() genuinely kills an in-flight gate step (Copilot #10)",
    async () => {
      // Real, disclosed bug this test proves fixed: before this fix,
      // runGate() never wrote anything to runs/status.json at all, so
      // routes/task-control.ts's cancel route (which only iterates
      // status.json's own "running" entries and calls cancelRun() for
      // each) had nothing to find -- cancelling a task mid-gate left the
      // gate subprocess running to completion regardless. This drives a
      // real, genuinely long-running step and calls the real, exported
      // cancelRun() against it exactly the way the daemon's own cancel
      // route does, not a mock.
      const cwd = await newCwd();
      const taskDir = join(cwd, "task");
      await writeProjectJson(cwd, { lint: `${NODE} -e "setTimeout(() => {}, 30000)"` });

      const gatePromise = runGate(cwd, taskDir, 1);
      const statusPath = join(taskDir, "runs", "status.json");

      // Wait for the real "running" status entry with a real pid -- the
      // actual claim this fix makes, not assumed to appear instantly.
      let pid: number | undefined;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const status = JSON.parse(await readFile(statusPath, "utf-8")) as Record<string, { state?: string; pid?: number }>;
          if (status["gate-r1"]?.state === "running" && typeof status["gate-r1"]?.pid === "number") {
            pid = status["gate-r1"].pid;
            break;
          }
        } catch {
          // status.json not written yet
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pid).toBeTypeOf("number");

      const start = Date.now();
      const { cancelled } = await cancelRun(taskDir, "gate-r1");
      expect(cancelled).toBe(true);

      // The real unblock claim: runGate() itself resolves well under the
      // step's own 30s sleep, because the process was actually killed,
      // not because it happened to finish on its own.
      const { result } = await gatePromise;
      const elapsedS = (Date.now() - start) / 1000;
      expect(elapsedS).toBeLessThan(10);
      expect(result.ok).toBe(false);

      const finalStatus = JSON.parse(await readFile(statusPath, "utf-8")) as Record<string, { state?: string }>;
      expect(finalStatus["gate-r1"]?.state).toBe("failed");
    },
    15_000,
  );

  it("honors a project-json path override", async () => {
    const cwd = await newCwd();
    const other = join(cwd, "elsewhere.json");
    await writeFile(other, JSON.stringify({ commands: { lint: `${NODE} -e "console.log(1)"` } }), "utf-8");
    const { result } = await runGate(cwd, join(cwd, "task"), 1, other);
    expect(result.steps[0]?.name).toBe("lint");
  });

  it("appends a gate.finished event", async () => {
    const cwd = await newCwd();
    await writeProjectJson(cwd, { lint: `${NODE} -e "console.log(1)"` });
    const taskDir = join(cwd, "task");
    await runGate(cwd, taskDir, 3);
    const events = (await readFile(join(taskDir, "events.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "gate.finished", run: null, data: { round: 3, ok: true } });
  });
});

describe("stepsToRun", () => {
  it("skips unconfigured commands", () => {
    expect(stepsToRun({ lint: "eslint .", typecheck: null, test: null })).toEqual([["lint", "eslint ."]]);
  });
});
