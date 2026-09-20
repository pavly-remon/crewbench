import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTask, makeTaskId } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo, sleep, waitForTaskKnown } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const QUICK_SUCCESS = join(REPO_ROOT, "tests", "fixtures", "fake_clis", "quick_success.py");

const VALID_SPEC = {
  title: "Add a reverse function",
  description: "Add a function reverse(str) in src/reverse.js.",
  acceptance_criteria: ["reverse('abc') returns 'cba'"],
  affected_areas: [],
  out_of_scope: [],
  needs_design: false,
  constraints: [],
};

const LINEUP_BODY = {
  roles: {
    developer: { cli: "claude", model: "m", effort: "none", permissions: "safe" },
    tester: { cli: "claude", model: "m", effort: "none", permissions: "safe" },
    "code-reviewer": { cli: "claude", model: "m", effort: "none", permissions: "safe" },
    "ui-ux": { cli: "claude", model: "m", effort: "none", permissions: "safe" },
  },
};

/** Same real fake-CLI pattern as `packages/cli/test/commit-flow.e2e.test.ts`
 * and `test/approvals.test.ts`'s own copy -- distinguishes developer/
 * tester/code-reviewer by a field unique to each role's own schema, so one
 * script answers every role correctly and the task genuinely reaches a
 * real commit approval. Used here for the *second* attempt after a retry,
 * to prove the retried round produces a real, different, passing result. */
async function fakeMultiRoleCli(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-taskcontrol-fakecli-"));
  const path = join(dir, "fake-claude.cjs");
  const script = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf-8");
  if (prompt.includes("tests_run")) {
    respond({ verdict: "pass", summary: "all good", tests_run: ["a.test.js"], tests_added: [], failures: [], blocked: [] });
  } else if (prompt.includes("previous_issues")) {
    respond({ verdict: "approve", summary: "looks good", issues: [], blocked: [] });
  } else if (prompt.includes("files_changed")) {
    require("fs").mkdirSync("src", { recursive: true });
    require("fs").writeFileSync("src/reverse.js", "module.exports = function reverse(str) { return str.split('').reverse().join(''); };");
    respond({ status: "done", summary: "did the thing", files_changed: ["src/reverse.js"], assumptions: [], questions: [], blocked: [] });
  } else {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-task-control", model: "m" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", permission_denials: [] }));
  }
  function respond(result) {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-task-control", model: "m" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", structured_output: result, permission_denials: [] }));
  }
});
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
  return path;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(100);
  }
}

describe("task control: POST /api/tasks/:tid/{cancel,resume,retry-run} (Phase 3 milestone 6)", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-task-control-home-"));
    process.env.CREWBENCH_HOME = home;
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }

  async function createStartedTask(headers: Record<string, string>, repo: string): Promise<{ pid: string; taskId: string; taskDir: string }> {
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "Add a reverse function" }),
    });
    const detail = (await createRes.json()) as { id: string };
    const finalizeRes = await fetch(url(`/api/tasks/${detail.id}/scoping/finalize`), {
      method: "POST",
      headers,
      body: JSON.stringify(VALID_SPEC),
    });
    expect(finalizeRes.status).toBe(200);
    const lineupRes = await fetch(url(`/api/tasks/${detail.id}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(lineupRes.status).toBe(200);
    const taskDir = join(repo, ".crewbench", "tasks", detail.id);
    return { pid: project.id, taskId: detail.id, taskDir };
  }

  /** Real, live proof cancel actually kills a genuinely in-flight
   * subprocess, not just that the HTTP call returns 200: `quick_success.py`'s
   * own `FAKE_CLI_SLEEP` env var (an existing fixture feature, ported from
   * the Python test suite) makes the developer dispatch sleep 6s before it
   * would ever respond on its own -- cancelling it and measuring real
   * wall-clock time proves the process was actually killed, not merely
   * waited out. */
  it("cancel: kills a genuinely in-flight developer dispatch, well under its own sleep time, and stops the task", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "6";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-cancel-");
    const { taskId, taskDir } = await createStartedTask(headers, repo);

    // Wait for the real developer subprocess to actually be running (a
    // real pid recorded in status.json, Phase 3 milestone 1's own
    // pid-recording fix), not just for the task to exist.
    await waitFor(async () => {
      const status = JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8").catch(() => "{}")) as Record<
        string,
        { state?: string; pid?: number }
      >;
      return status["developer-r1"]?.state === "running" && typeof status["developer-r1"]?.pid === "number";
    });

    const start = Date.now();
    const cancelRes = await fetch(url(`/api/tasks/${taskId}/cancel`), { method: "POST", headers, body: JSON.stringify({}) });
    expect(cancelRes.status).toBe(200);

    await waitFor(async () => {
      const res = await fetch(url(`/api/tasks/${taskId}`), { headers });
      const detail = (await res.json()) as { phase: string; active: boolean };
      return detail.phase === "stopped" && detail.active === false;
    });
    const elapsedMs = Date.now() - start;
    // The fake CLI sleeps 6s -- a genuine kill resolves in a small
    // fraction of that; a cancel that did nothing would take >=6000ms.
    expect(elapsedMs).toBeLessThan(4000);

    const detailRes = await fetch(url(`/api/tasks/${taskId}`), { headers });
    const detail = (await detailRes.json()) as { stuck_reason: string | null; notes: string[] };
    expect(detail.stuck_reason).toBe("cancelled by user");
    expect(detail.notes.some((n) => n.includes("Cancelled by user"))).toBe(true);

    const status = JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8")) as Record<string, { state?: string }>;
    expect(status["developer-r1"]?.state).toBe("failed");
  }, 20_000);

  it("cancel: 403s for a plugin-owned task", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-cancel-plugin-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    const taskId = makeTaskId("plugin task");
    await createTask(join(repo, ".crewbench", "tasks", taskId), { id: taskId, command: "new-task", title: "Plugin task" });
    await waitForTaskKnown(url(""), daemon.token, taskId);

    const res = await fetch(url(`/api/tasks/${taskId}/cancel`), { method: "POST", headers, body: JSON.stringify({}) });
    expect(res.status).toBe(403);
    void project;
  });

  it("resume: 400s for an active task, 400s for a non-terminal task, and genuinely restarts a cancelled one", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "6";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    // `/resume` takes no body -- deliberately no `Content-Type` here,
    // matching how `lib/api.ts`'s real `apiFetch()` only sets it `if
    // (init.body ...)`. Found live: reusing `headers` (which always
    // carries `Content-Type: application/json`) made Fastify's default
    // JSON body parser reject every bodyless `/resume` call outright
    // (`FST_ERR_CTP_EMPTY_JSON_BODY`, a 400 before the route handler
    // ever ran) -- a real gap in this test, not in the route or the real
    // client, which never sends that header without an actual body.
    const noBodyHeaders = { Authorization: headers.Authorization };
    const repo = await gitRepo("crewbench-resume-");
    const { taskId, taskDir } = await createStartedTask(headers, repo);

    // Still actively dispatching developer-r1 -- resume must 400, not
    // race the live loop.
    const activeRes = await fetch(url(`/api/tasks/${taskId}/resume`), { method: "POST", headers: noBodyHeaders });
    expect(activeRes.status).toBe(400);

    await fetch(url(`/api/tasks/${taskId}/cancel`), { method: "POST", headers, body: JSON.stringify({}) });
    await waitFor(async () => {
      const res = await fetch(url(`/api/tasks/${taskId}`), { headers });
      const detail = (await res.json()) as { phase: string; active: boolean };
      return detail.phase === "stopped" && detail.active === false;
    });

    // The real claim: resuming a cancelled task genuinely re-enters
    // decide()/reduce() from wherever the file-backed replay leaves it --
    // here, developer-r1 already has a (killed, ok:false) result on disk,
    // so replay treats it as "developer done" (engine's real, pre-existing
    // rule: developer.finished never inspects ok) and the very next real
    // step is a genuinely fresh run_gate() call for round 1, something
    // that never happened before cancel. gate-r1.result.json appearing is
    // proof resume actually did new work, not a no-op -- and it needs no
    // CLI subprocess at all (runGate() is a local check), so this
    // assertion doesn't depend on the fake CLI's own behavior for
    // whatever role gets dispatched afterward.
    expect(existsSync(join(taskDir, "runs", "gate-r1.result.json"))).toBe(false);
    const resumeRes = await fetch(url(`/api/tasks/${taskId}/resume`), { method: "POST", headers: noBodyHeaders });
    expect(resumeRes.status).toBe(200);
    await waitFor(async () => existsSync(join(taskDir, "runs", "gate-r1.result.json")));

    const detailRes = await fetch(url(`/api/tasks/${taskId}`), { headers });
    const detail = (await detailRes.json()) as { notes: string[] };
    expect(detail.notes.some((n) => n.includes("Resumed by user"))).toBe(true);
  }, 25_000);

  it("resume: 400s a task that isn't in a stopped/failed phase", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-resume-badphase-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "Add a reverse function" }),
    });
    const detail = (await createRes.json()) as { id: string };
    // Still "scoping" -- never finalized, never started. No body/
    // Content-Type here either, matching the real client -- otherwise a
    // 400 from Fastify's empty-JSON-body rejection (see the previous
    // test's own note) would pass this assertion for the wrong reason.
    const res = await fetch(url(`/api/tasks/${detail.id}/resume`), { method: "POST", headers: { Authorization: headers.Authorization } });
    expect(res.status).toBe(400);
  });

  it("retry-run: cancelling a genuinely in-flight developer dispatch, then retrying it, produces a real new result and drives the task all the way to a real commit approval", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "6";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-retry-");
    const { taskId, taskDir } = await createStartedTask(headers, repo);

    await waitFor(async () => {
      const status = JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8").catch(() => "{}")) as Record<
        string,
        { state?: string }
      >;
      return status["developer-r1"]?.state === "running";
    });
    await fetch(url(`/api/tasks/${taskId}/cancel`), { method: "POST", headers, body: JSON.stringify({}) });
    await waitFor(async () => {
      const res = await fetch(url(`/api/tasks/${taskId}`), { headers });
      const detail = (await res.json()) as { phase: string; active: boolean };
      return detail.phase === "stopped" && detail.active === false;
    });

    const firstEnvelope = JSON.parse(await readFile(join(taskDir, "runs", "developer-r1.result.json"), "utf-8")) as { ok: boolean };
    expect(firstEnvelope.ok).toBe(false); // the killed attempt's own real, failed envelope

    // Retrying a round other than the current one is rejected -- there's
    // only round 1 here, so prove the guard with a round that doesn't
    // exist at all rather than fabricating a second real round just for
    // this assertion.
    const badRound = await fetch(url(`/api/tasks/${taskId}/retry-run`), {
      method: "POST",
      headers,
      body: JSON.stringify({ run: "developer-r2" }),
    });
    expect(badRound.status).toBe(400);

    // Swap in a fake CLI that genuinely succeeds for every role, so the
    // retried developer dispatch -- and everything decide()/reduce()
    // naturally re-enters after it -- can actually complete, all the way
    // to a real commit approval.
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = await fakeMultiRoleCli();
    delete process.env.FAKE_CLI_SLEEP;

    const retryRes = await fetch(url(`/api/tasks/${taskId}/retry-run`), {
      method: "POST",
      headers,
      body: JSON.stringify({ run: "developer-r1" }),
    });
    expect(retryRes.status).toBe(200);

    await waitFor(async () => {
      const res = await fetch(url("/api/approvals"), { headers });
      const rows = (await res.json()) as Array<{ task_id: string; kind: string }>;
      return rows.some((r) => r.task_id === taskId && r.kind === "commit");
    }, 20_000);

    const retriedEnvelope = JSON.parse(await readFile(join(taskDir, "runs", "developer-r1.result.json"), "utf-8")) as {
      ok: boolean;
      result: { files_changed: string[] };
    };
    expect(retriedEnvelope.ok).toBe(true); // a genuinely new, different result -- not the stale killed one
    expect(retriedEnvelope.result.files_changed).toEqual(["src/reverse.js"]);
    // The fake CLI writes relative to its own cwd, which is the *project*
    // root (`repo`), not `taskDir` (`.crewbench/tasks/<id>`) -- app-owned
    // tasks have no worktree (milestone 5's own disclosed finding), so
    // `TaskRunner.buildParams()`'s `cwd` is `projectPath` directly
    // (`task-runner.ts`). Checking under `taskDir` here would always be
    // false regardless of whether the write genuinely happened.
    expect(existsSync(join(repo, "src", "reverse.js"))).toBe(true); // the retried developer's real file write

    const detailRes = await fetch(url(`/api/tasks/${taskId}`), { headers });
    const detail = (await detailRes.json()) as { notes: string[] };
    expect(detail.notes.some((n) => n.includes("Retrying developer-r1"))).toBe(true);
  }, 30_000);

  it("retry-run: 400s while the task is active", async () => {
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "6";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-retry-active-");
    const { taskId } = await createStartedTask(headers, repo);

    const res = await fetch(url(`/api/tasks/${taskId}/retry-run`), { method: "POST", headers, body: JSON.stringify({ run: "developer-r1" }) });
    expect(res.status).toBe(400);
  }, 15_000);

  it("retry-run: 400s a malformed run name (ui-ux, or no round suffix)", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-retry-malformed-");
    const { taskId } = await createStartedTask(headers, repo);
    // Cancel immediately so the task is inactive -- the malformed-run
    // check should fire before the round-currency check either way, but
    // this keeps the test from depending on that ordering.
    await fetch(url(`/api/tasks/${taskId}/cancel`), { method: "POST", headers, body: JSON.stringify({}) });

    const res = await fetch(url(`/api/tasks/${taskId}/retry-run`), { method: "POST", headers, body: JSON.stringify({ run: "ui-ux-r1" }) });
    expect(res.status).toBe(400);
  });
});
