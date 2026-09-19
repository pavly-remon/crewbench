import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGate, stepsToRun } from "../src/gate.js";

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
