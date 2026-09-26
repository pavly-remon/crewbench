import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo, sleep, waitForTaskKnown } from "./helpers.js";
import { computePtyCapability } from "../src/pty-capability.js";

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

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(100);
  }
}

/** A real, isolated fake `crewbench` CLI entry for the PTY plumbing test
 * below -- deliberately *not* `crewbench resume`'s own real logic (that's
 * separately proven by `packages/cli/test/resume.e2e.test.ts`, including
 * this milestone's own fix to it). This script's only job is to prove
 * `routes/pty.ts`'s actual channel plumbing works: a real pty spawned, a
 * real bidirectional byte flow, a real resize call reaching the child,
 * and a real exit code reported back over the socket -- reading argv
 * (`resume <task-id>`) to prove the daemon really did invoke it with the
 * right arguments too. */
async function fakePtyTarget(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-pty-fake-entry-"));
  const path = join(dir, "fake-bin.cjs");
  const script = `#!/usr/bin/env node
const [, , command, taskId] = process.argv;
process.stdout.write("ARGV:" + command + ":" + taskId + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const line = chunk.toString().trim();
  if (line === "resize-check") {
    process.stdout.write("COLS:" + process.stdout.columns + "\\n");
  } else if (line === "quit") {
    process.exit(7);
  } else {
    process.stdout.write("ECHO:" + line + "\\n");
  }
});
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
  return path;
}

/** Real WebSocket client helper -- opens the connection, resolves with
 * either `{ok: true, ws}` (connection genuinely opened) or
 * `{ok: false, status}` (the real HTTP status the server's own
 * `preHandler` rejected the upgrade with, per `ws`'s own documented
 * `unexpected-response` event) -- used both to prove a real session
 * opens for a resumable task and to prove the server-side guards
 * actually block one that isn't. */
function connect(url: string, token: string): Promise<{ ok: true; ws: WebSocket } | { ok: false; status: number }> {
  return new Promise((resolvePromise) => {
    const ws = new WebSocket(`${url}?token=${token}`);
    ws.once("open", () => resolvePromise({ ok: true, ws }));
    ws.once("unexpected-response", (_req, res) => {
      res.resume(); // drain, avoid a dangling socket
      resolvePromise({ ok: false, status: res.statusCode ?? 0 });
    });
    ws.once("error", () => {
      // Some environments raise 'error' instead of 'unexpected-response'
      // for a rejected upgrade -- treated the same as a generic reject
      // by callers that only assert ok:false, not a specific status.
      resolvePromise({ ok: false, status: 0 });
    });
  });
}

describe("GET /api/capabilities, GET /api/tasks/:tid/pty (Phase 4 milestone 3)", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };

  // A real, serious pre-existing gap found live while debugging this
  // exact test file under `pnpm -r test`: `daemonHome()` (registry.ts)
  // defaults to the *real* `~/.crewbench` when `CREWBENCH_HOME` isn't
  // set. Several daemon test files (not just this one -- confirmed by
  // grep: fs-browse.test.ts, models.test.ts, plugin-install.test.ts,
  // profile.test.ts, task-runner.test.ts, tasks-mutating.test.ts,
  // team.test.ts, all pre-existing, none written by this milestone
  // except this file) never override it, so every `startDaemon()` call
  // in those files reads -- and, worse, `reattachProject()`s startup
  // logic can *act on* -- this real machine's own real
  // `~/.crewbench/projects.json`. This was actively happening: a real
  // `pnpm -r test` run left dozens of stale temp-directory project
  // entries in the real file (confirmed by reading it directly).
  // Flagged prominently in this milestone's own log as a real, urgent,
  // repo-wide finding beyond this milestone's own scope to fully fix --
  // this file's own instance of the gap is fixed here.
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-pty-home-"));
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
  function wsUrl(path: string): string {
    return `ws://127.0.0.1:${daemon.port}${path}`;
  }

  async function createStoppedTask(headers: Record<string, string>, repo: string): Promise<{ taskId: string; projectId: string }> {
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "Add a reverse function" }),
    });
    const detail = (await createRes.json()) as { id: string };
    await fetch(url(`/api/tasks/${detail.id}/scoping/finalize`), { method: "POST", headers, body: JSON.stringify(VALID_SPEC) });
    await fetch(url(`/api/tasks/${detail.id}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    const taskDir = join(repo, ".crewbench", "tasks", detail.id);

    // Real, genuine "stopped" phase: a real in-flight dispatch, really
    // cancelled (same real mechanism Phase 3 milestone 6's own cancel
    // test uses) -- not a hand-written state.json field, so this proves
    // the pty route's own preHandler reads the exact same live state
    // buildTaskDetail() does, not a fixture-only shortcut.
    await waitFor(async () => {
      const status = JSON.parse(await readFile(join(taskDir, "runs", "status.json"), "utf-8").catch(() => "{}")) as Record<
        string,
        { state?: string; pid?: number }
      >;
      return status["developer-r1"]?.state === "running" && typeof status["developer-r1"]?.pid === "number";
    });
    await fetch(url(`/api/tasks/${detail.id}/cancel`), { method: "POST", headers, body: JSON.stringify({}) });
    await waitFor(async () => {
      const res = await fetch(url(`/api/tasks/${detail.id}`), { headers });
      const d = (await res.json()) as { phase: string; active: boolean };
      return d.phase === "stopped" && d.active === false;
    });
    return { taskId: detail.id, projectId: project.id };
  }

  it("GET /api/capabilities reports the real, live-detected pty capability", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/capabilities"), { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pty: boolean };
    // Not hardcoded true/false -- matches whatever this real machine's
    // own real capability check (the same function the route calls)
    // actually reports, so this test stays honest on a machine where
    // node-pty genuinely isn't available.
    expect(body.pty).toBe(computePtyCapability().available);
  });

  it("opens a real session for a stopped task: real argv, real bidirectional bytes, a real resize, and a real exit code", async () => {
    if (!computePtyCapability().available) return; // nothing to prove on a machine without a working node-pty
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    const fakeEntry = await fakePtyTarget();
    daemon = await startDaemon({ port: 0, cliEntryPath: fakeEntry });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-pty-");
    const { taskId } = await createStoppedTask(headers, repo);
    await waitForTaskKnown(url(""), daemon.token, taskId);

    const conn = await connect(wsUrl(`/api/tasks/${taskId}/pty`), daemon.token);
    expect(conn.ok).toBe(true);
    if (!conn.ok) return;
    const ws = conn.ws;

    const messages: Array<{ type: string; data?: string; code?: number }> = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

    // 1. Real argv proof: the fake entry prints exactly what it was
    // invoked with -- confirms the daemon spawned `<cliEntryPath> resume
    // <taskId>`, not something else.
    await waitFor(async () => messages.some((m) => m.type === "output" && (m.data ?? "").includes(`ARGV:resume:${taskId}`)));

    // 2. Real input -> real output round trip.
    ws.send(JSON.stringify({ type: "input", data: "hello-pty\n" }));
    await waitFor(async () => messages.some((m) => m.type === "output" && (m.data ?? "").includes("ECHO:hello-pty")));

    // 3. A real resize call actually reaches the child's own pty (not
    // just accepted and dropped) -- the fake script reads back
    // `process.stdout.columns`, which only reflects a genuine pty
    // resize, not a value this test could fake any other way.
    ws.send(JSON.stringify({ type: "resize", cols: 137, rows: 41 }));
    ws.send(JSON.stringify({ type: "input", data: "resize-check\n" }));
    await waitFor(async () => messages.some((m) => m.type === "output" && (m.data ?? "").includes("COLS:137")));

    // 4. A real exit code, not assumed zero.
    ws.send(JSON.stringify({ type: "input", data: "quit\n" }));
    await waitFor(async () => messages.some((m) => m.type === "exit"));
    const exitMsg = messages.find((m) => m.type === "exit");
    expect(exitMsg?.code).toBe(7);
  }, 20_000);

  it("rejects the upgrade with 409 for a task the daemon is already actively driving -- the real finding-7 hazard, blocked server-side", async () => {
    if (!computePtyCapability().available) return;
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = QUICK_SUCCESS;
    process.env.FAKE_CLI_SLEEP = "6";
    const fakeEntry = await fakePtyTarget();
    daemon = await startDaemon({ port: 0, cliEntryPath: fakeEntry });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-pty-active-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    const createRes = await fetch(url(`/api/projects/${project.id}/tasks`), {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "Add a reverse function" }),
    });
    const detail = (await createRes.json()) as { id: string };
    await fetch(url(`/api/tasks/${detail.id}/scoping/finalize`), { method: "POST", headers, body: JSON.stringify(VALID_SPEC) });
    await fetch(url(`/api/tasks/${detail.id}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });

    await waitFor(async () => {
      const res = await fetch(url(`/api/tasks/${detail.id}`), { headers });
      const d = (await res.json()) as { active: boolean };
      return d.active === true;
    });

    const conn = await connect(wsUrl(`/api/tasks/${detail.id}/pty`), daemon.token);
    expect(conn.ok).toBe(false);
    if (!conn.ok) expect(conn.status).toBe(409);
  }, 15_000);

  it("rejects the upgrade with 403 for a plugin-owned task", async () => {
    if (!computePtyCapability().available) return;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-pty-plugin-");
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };
    // A real plugin-owned task: created directly on disk with no `owner`
    // field (the historical default -- Design decision 5), never through
    // the app's own task-creation endpoint.
    const { createTask } = await import("@crewbench/engine");
    const taskDir = join(repo, ".crewbench", "tasks", "plugin-task");
    await createTask(taskDir, { id: "plugin-task", command: "new-task", title: "T" });
    await waitForTaskKnown(url(""), daemon.token, "plugin-task");

    const conn = await connect(wsUrl(`/api/tasks/plugin-task/pty`), daemon.token);
    expect(conn.ok).toBe(false);
    if (!conn.ok) expect(conn.status).toBe(403);
    void project;
  }, 15_000);

  it("rejects the upgrade with 404 for an unknown task", async () => {
    daemon = await startDaemon({ port: 0 });
    const conn = await connect(wsUrl(`/api/tasks/no-such-task/pty`), daemon.token);
    expect(conn.ok).toBe(false);
    if (!conn.ok) expect(conn.status).toBe(404);
  });
});
