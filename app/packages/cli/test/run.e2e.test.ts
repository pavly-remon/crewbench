import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const BIN = resolve(__dirname, "..", "dist", "bin.js");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-cli-e2e-"));
  const run = (args: string[]) => new Promise<void>((res, rej) => execFile("git", args, { cwd: dir }, (err) => (err ? rej(err) : res())));
  await run(["init", "-q"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await writeFile(join(dir, "a.txt"), "hello\n");
  await run(["add", "a.txt"]);
  await run(["commit", "-q", "-m", "init"]);
  return dir;
}

/** Full end-to-end smoke test: real subprocess (the built `crewbench`
 * bin), real worktree creation, real dispatch against the same fake CLI
 * fixture the engine/adapters suites use, driven entirely through
 * `--yes` + piped stdin (no test-only seam in run.ts itself -- this
 * exercises exactly what a user would run). quick_success.py always
 * returns a developer-shaped result regardless of which role asked, so
 * tester/code-reviewer dispatches are expected to fail schema validation
 * every round and the task is expected to stop at max_rounds -- the point
 * of this test is that the whole pipeline (scoping -> lineup -> worktree
 * -> fix loop -> stopped summary) runs to completion without crashing or
 * hanging, not that this fixture happens to satisfy every role's schema. */
describe("crewbench run (end to end, fake CLI)", () => {
  it("runs the full fix loop to a clean 'stopped' outcome at max_rounds", async () => {
    const repo = await gitRepo();
    const env = {
      ...process.env,
      CREWBENCH_ROOT: REPO_ROOT,
      CREWBENCH_CLI_OVERRIDE_CLAUDE: QUICK_SUCCESS,
    };

    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolveResult) => {
      const child = execFile(
        process.execPath,
        [BIN, "run", "fix the thing", "--yes", "--rounds", "1"],
        { cwd: repo, env, timeout: 30_000 },
        (err, out) => resolveResult({ stdout: out, code: err && "code" in err ? (err.code as number) : 0 }),
      );
      child.stdin?.write("n\n"); // "n" to the project-profile save prompt (only prompt --yes doesn't bypass)
      child.stdin?.end();
    });

    expect(code).toBe(0);
    expect(stdout).toContain("Dispatching developer (round 1)");
    expect(stdout).toContain("Running gate (round 1)");
    expect(stdout).toContain("Dispatching tester + code-reviewer (round 1)");
    expect(stdout).toContain("stopped.");
    expect(stdout).toContain("still failing after 1 rounds");

    // Real files on disk, in the real contract layout, from a real worktree.
    const tasksDir = join(repo, ".crewbench", "tasks");
    const taskIds = readdirSync(tasksDir);
    expect(taskIds).toHaveLength(1);
    const taskDir = join(tasksDir, taskIds[0] as string);
    const state = JSON.parse(await readFile(join(taskDir, "state.json"), "utf-8"));
    expect(state.phase).toBe("stopped");
    expect(state.round).toBe(1);
  }, 45_000);
});
