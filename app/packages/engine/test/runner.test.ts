import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchRole, dispatchVerification } from "../src/runner.js";
import type { DispatchParams } from "../src/runner.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "agents");
const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
const QUICK_SUCCESS = join(FIXTURES, "fake_clis", "quick_success.py");

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-runner-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "hello\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

// Ported in spirit from tests/test_detached_dispatch.py -- real subprocess
// dispatch against the same fake_clis/quick_success.py fixture, proving the
// TS runner writes the exact contract file family, not just that it parses
// fixture text.
describe("dispatchRole", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it("runs a role end to end against a fake CLI and writes the full contract file family", async () => {
    const repo = await gitRepo();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    const taskDir = join(repo, ".crewbench", "tasks", "t1");

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
      schemaPath: join(REPO_ROOT, "schemas", "developer.json"),
      timeoutS: 15,
    };

    const envelope = await dispatchRole(params);
    expect(envelope.ok).toBe(true);
    expect(envelope.result).toMatchObject({ status: "done" });
    expect(envelope.session_id).toBe("quick-0001");
    expect(envelope.resume_command).toBe("claude --resume quick-0001");

    const runsDir = join(taskDir, "runs");
    for (const file of ["developer-r1.md", "developer-r1.prompt.md", "developer-r1.log", "developer-r1.result.json", "developer-r1.raw.txt"]) {
      const content = await readFile(join(runsDir, file), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }

    const status = JSON.parse(await readFile(join(runsDir, "status.json"), "utf-8"));
    expect(status["developer-r1"]).toMatchObject({ state: "done", session_id: "quick-0001" });

    const events = (await readFile(join(taskDir, "events.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types[types.length - 1]).toBe("run.finished");
    expect(events.every((e: { run: string }) => e.run === "developer-r1")).toBe(true);
    const seqs = events.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 20_000);

  it("reports a clear error when the CLI isn't installed, without spawning anything", async () => {
    // The oversized-argv guard is already covered at the adapter level
    // (packages/adapters/test/build-command.test.ts) -- the only way to
    // trigger it is a huge *prompt-file path*, which dispatchRole()
    // computes internally and doesn't expose to a caller, so it isn't
    // reachable through this public interface. "CLI not installed" is the
    // runner-level pre-flight error this test can actually exercise.
    const repo = await gitRepo();
    process.env.CREWBENCH_CLI_OVERRIDE_CODEX = "";
    process.env.PATH = "/nonexistent";
    const taskDir = join(repo, ".crewbench", "tasks", "t2");
    const params: DispatchParams = {
      role: "developer",
      cli: "codex",
      model: "m",
      effort: "none",
      permissions: "safe",
      taskDir,
      round: 1,
      cwd: repo,
      handoff: "Task: anything\n",
      agentsDir: AGENTS_DIR,
      schemaPath: join(REPO_ROOT, "schemas", "developer.json"),
    };
    const envelope = await dispatchRole(params);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("not installed");
  });
});

describe("dispatchVerification", () => {
  it("runs tester and code-reviewer in parallel", async () => {
    const repo = await gitRepo();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    const taskDir = join(repo, ".crewbench", "tasks", "t3");
    const base: Omit<DispatchParams, "role" | "schemaPath"> = {
      cli: "claude",
      model: "m",
      effort: "none",
      permissions: "safe",
      taskDir,
      round: 1,
      cwd: repo,
      handoff: "Task: anything\n",
      agentsDir: AGENTS_DIR,
      timeoutS: 15,
    };
    const { tester, reviewer } = await dispatchVerification(
      { ...base, role: "tester", schemaPath: join(REPO_ROOT, "schemas", "tester.json") },
      { ...base, role: "code-reviewer", schemaPath: join(REPO_ROOT, "schemas", "code-reviewer.json") },
    );
    // quick_success.py's fixture output is developer-shaped, so parsing it
    // against tester/code-reviewer's schemas is expected to report a
    // schema mismatch (see the dedicated schema-validation test below for
    // the positive case) -- the point of this test is that both runs
    // happened and wrote their own files, not that the fixture happens to
    // satisfy every role's schema.
    expect(tester.result).not.toBeNull();
    expect(reviewer.result).not.toBeNull();
    expect(tester.ok).toBe(false);
    expect(tester.error).toBeTruthy();
    const runsDir = join(taskDir, "runs");
    await expect(readFile(join(runsDir, "tester-r1.result.json"), "utf-8")).resolves.toBeTruthy();
    await expect(readFile(join(runsDir, "code-reviewer-r1.result.json"), "utf-8")).resolves.toBeTruthy();
  }, 20_000);
});

describe("dispatchRole: result schema validation", () => {
  // Regression coverage: Python's crewbench_dispatch.py rejects a result
  // that doesn't match schemas/<role>.json (`problem = error or
  // validate(result, schema)`) -- an earlier version of this port never
  // ran that check, so any parseable-JSON result was silently accepted
  // as ok:true regardless of shape. Confirmed above (schema mismatch ->
  // ok:false); this confirms the matching case still reports ok:true.
  it("a matching result validates and reports ok:true", async () => {
    const repo = await gitRepo();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    const taskDir = join(repo, ".crewbench", "tasks", "t4");
    const params: DispatchParams = {
      role: "developer", // quick_success.py's fixture IS developer-shaped
      cli: "claude",
      model: "m",
      effort: "none",
      permissions: "safe",
      taskDir,
      round: 1,
      cwd: repo,
      handoff: "Task: anything\n",
      agentsDir: AGENTS_DIR,
      schemaPath: join(REPO_ROOT, "schemas", "developer.json"),
      timeoutS: 15,
    };
    const envelope = await dispatchRole(params);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeNull();
  }, 20_000);
});
