import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchRole, dispatchVerification } from "../src/runner.js";
import type { DispatchParams } from "../src/runner.js";
import { ConcurrencyLimiter } from "../src/concurrency.js";

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
    // Regression: reconcileDeadRuns()/cancelRun() (resume.ts) both read a
    // `pid` field off a "running" status.json entry, but nothing ever
    // wrote one -- found while building Phase 3 milestone 1's reattach
    // logic. A real child process really was spawned for this dispatch,
    // so its pid must be a real positive integer, not just present.
    expect(typeof status["developer-r1"].pid).toBe("number");
    expect(status["developer-r1"].pid).toBeGreaterThan(0);

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

  // Regression: a real, reproducible hang caught live in Phase 3
  // milestone 1's end-to-end verification (crewbench resume's own e2e
  // test, timing out at exactly its 30s ceiling on its third round of
  // parallel tester+code-reviewer dispatches). Root cause: the pid-
  // capture fix above (`onSpawn`) was originally awaited *before*
  // spawnAndCollect() attached its `child.once("exit", ...)` listener --
  // for a child process fast enough to exit during that await's yield to
  // the event loop (quick_success.py, with nothing to sleep for), `exit`
  // could fire before anything was listening for it, and the run's
  // result promise then never resolved. Fixed by building (not
  // awaiting) the exit-watching promise synchronously, in the same tick
  // as spawn(), before `onSpawn` is ever awaited. A single dispatch
  // reproduces this only intermittently (real OS process-scheduling
  // timing, not deterministic) -- many rapid, parallel dispatches of the
  // same near-instant fixture make the race window get hit reliably if
  // it ever regresses, without needing a fixed artificial delay.
  // Verified directly before settling on 80: temporarily reintroduced
  // the exact buggy ordering and confirmed this test reliably times out
  // against it (3/3 runs), then confirmed it reliably passes in ~2-3s
  // against the fix (3/3 runs) -- an effective regression test, not
  // just a plausible-sounding one. 20 dispatches wasn't enough to
  // reliably trigger the race on this machine.
  it("does not hang when many fast-exiting dispatches race in parallel", async () => {
    const repo = await gitRepo();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    const taskDir = join(repo, ".crewbench", "tasks", "race");
    const base: Omit<DispatchParams, "round"> = {
      role: "developer",
      cli: "claude",
      model: "m",
      effort: "none",
      permissions: "safe",
      taskDir,
      cwd: repo,
      handoff: "Task: anything\n",
      agentsDir: AGENTS_DIR,
      schemaPath: join(REPO_ROOT, "schemas", "developer.json"),
      timeoutS: 10,
    };
    const envelopes = await Promise.all(Array.from({ length: 80 }, (_, i) => dispatchRole({ ...base, round: i + 1 })));
    expect(envelopes).toHaveLength(80);
    expect(envelopes.every((e) => e.ok)).toBe(true);
  }, 15_000);
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

describe("dispatchRole: concurrency limiter (Phase 3 milestone 2)", () => {
  // The plan's own acceptance bar: two real tasks, same CLI, a limit of
  // 1 -- the second dispatch genuinely waits and only starts once the
  // first's slot frees, proven by real timing (quick_success.py's own
  // FAKE_CLI_SLEEP support), not a mock or a fake clock.
  it("serializes two real dispatches for the same CLI under a limit of 1", async () => {
    const repo = await gitRepo();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "0.4";
    const taskDir = join(repo, ".crewbench", "tasks", "concurrency");
    const limiter = new ConcurrencyLimiter({ claude: 1 });
    const base: Omit<DispatchParams, "round"> = {
      role: "developer",
      cli: "claude",
      model: "m",
      effort: "none",
      permissions: "safe",
      taskDir,
      cwd: repo,
      handoff: "Task: anything\n",
      agentsDir: AGENTS_DIR,
      schemaPath: join(REPO_ROOT, "schemas", "developer.json"),
      timeoutS: 15,
      limiter,
    };

    const start = Date.now();
    const [first, second] = await Promise.all([dispatchRole({ ...base, round: 1 }), dispatchRole({ ...base, round: 2 })]);
    const elapsedS = (Date.now() - start) / 1000;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Each real dispatch sleeps ~0.4s before its own subprocess exits --
    // serialized under a limit of 1, the pair takes at least that long
    // twice over; truly parallel (the bug this test guards against)
    // would finish in ~0.4s total.
    expect(elapsedS).toBeGreaterThanOrEqual(0.75);

    const events = (await readFile(join(taskDir, "events.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.some((e) => e.type === "run.queued")).toBe(true);
    expect(events.some((e) => e.type === "run.dequeued")).toBe(true);
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

  // Regression: caught live against the real codex CLI during Phase 1
  // milestone 7's end-to-end verification run, not by any fixture --
  // normalizeOptionalNulls() was ported and unit-tested in Phase 1
  // milestone 1 but never actually wired into dispatchRole()'s pipeline.
  // Under OpenAI's structured-outputs strict mode, codex must supply
  // every property from its schema, so an optional field with nothing to
  // report (round 1's `previous_issues`) comes back as an explicit
  // `null` rather than omitted -- without normalizeOptionalNulls()
  // stripping that null back out before validation, a real round-1
  // code-reviewer dispatch failed with "previous_issues Invalid input:
  // expected array, received null" on every single run.
  it("strips an explicit null on an optional field before validating (the codex strict-mode shape)", async () => {
    const repo = await gitRepo();
    const fakeCliPath = await writeFakeCliWithNullOptionalField(repo);
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = fakeCliPath;
    const taskDir = join(repo, ".crewbench", "tasks", "t5");
    const params: DispatchParams = {
      role: "code-reviewer",
      cli: "claude",
      model: "m",
      effort: "none",
      permissions: "safe",
      taskDir,
      round: 1,
      cwd: repo,
      handoff: "Task: anything\n",
      agentsDir: AGENTS_DIR,
      schemaPath: join(REPO_ROOT, "schemas", "code-reviewer.json"),
      timeoutS: 15,
    };
    const envelope = await dispatchRole(params);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeNull();
    expect(envelope.result).not.toHaveProperty("previous_issues");
  }, 20_000);
});

async function writeFakeCliWithNullOptionalField(dir: string): Promise<string> {
  const path = join(dir, "fake-null-optional.cjs");
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-null-opt", model: "m" }));
console.log(JSON.stringify({
  type: "result", subtype: "success", is_error: false, status: "SUCCESS",
  structured_output: { verdict: "approve", summary: "ok", issues: [], previous_issues: null, blocked: [] },
  permission_denials: [],
}));
`;
  await writeFile(path, script, "utf-8");
  await execFileAsync("chmod", ["+x", path]);
  return path;
}
