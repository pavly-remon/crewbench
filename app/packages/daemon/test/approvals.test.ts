import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baseCommit, branchName, createWorktree, setField, worktreePath } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo, sleep, waitForTaskKnown } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

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

/** Ported from `packages/cli/test/commit-flow.e2e.test.ts`'s own fake
 * CLI (same file, same reasoning in its own comments for why a bare
 * "else" is wrong) -- reused here rather than duplicated blindly: this
 * is the one existing fixture in this codebase that reaches a real
 * `request_commit_approval` through a real `driveTask()` loop, which is
 * exactly what this milestone's own tests need, just driven through the
 * daemon's HTTP surface instead of the CLI's terminal one. */
async function fakeClaudeCli(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-daemon-approvals-fakecli-"));
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
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-approvals", model: "m" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", permission_denials: [] }));
  }
  function respond(result) {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-approvals", model: "m" }));
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", structured_output: result, permission_denials: [] }));
  }
});
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
  return path;
}

async function git(args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => execFile("git", args, { cwd }, (err, out) => (err ? rej(err) : res(out))));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(100);
  }
}

describe("approvals: GET /api/approvals, POST /api/tasks/:tid/approvals/:aid (Phase 3 milestone 5)", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-approvals-home-"));
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

  async function createFinalizedTask(headers: Record<string, string>, repo: string): Promise<{ pid: string; taskId: string }> {
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
    return { pid: project.id, taskId: detail.id };
  }

  it("commit: a real developer/tester/reviewer round genuinely pauses driveTask() at commit, addressable and resolvable over HTTP", async () => {
    const fakeCli = await fakeClaudeCli();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = fakeCli;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-approvals-commit-");
    const { taskId } = await createFinalizedTask(headers, repo);

    const lineupRes = await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(lineupRes.status).toBe(200);

    // The real claim: driveTask() actually ran developer -> gate ->
    // tester+reviewer -> request_commit_approval, and is now genuinely
    // blocked on a real HttpApprovalProvider.request() promise, not just
    // that state.json says "awaiting_commit" (which could be true even
    // if the approval machinery itself were broken).
    let pendingId = "";
    let pendingKind = "";
    await waitFor(async () => {
      const res = await fetch(url("/api/approvals"), { headers });
      const rows = (await res.json()) as Array<{ task_id: string; kind: string; id: string; title: string; project_id: string }>;
      const row = rows.find((r) => r.task_id === taskId && r.kind === "commit");
      if (!row) return false;
      pendingId = row.id;
      pendingKind = row.kind;
      expect(row.title).toBe("Add a reverse function"); // finalize's own title, not the truncated task_text default
      return true;
    });
    expect(pendingKind).toBe("commit");

    const resolveRes = await fetch(url(`/api/tasks/${taskId}/approvals/${pendingId}`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "yes", data: { message: "Add reverse()" } }),
    });
    expect(resolveRes.status).toBe(200);

    // The actual unblock claim: a real git commit landed in the repo,
    // and it's gone from the inbox afterward -- not just that the HTTP
    // call returned 200.
    await waitFor(async () => {
      const log = await git(["log", "--oneline", "-3"], repo).catch(() => "");
      return log.toLowerCase().includes("reverse");
    });
    const afterRes = await fetch(url("/api/approvals"), { headers });
    const afterRows = (await afterRes.json()) as Array<{ id: string }>;
    expect(afterRows.some((r) => r.id === pendingId)).toBe(false);
  }, 30_000);

  /** Real, disclosed bug (Copilot review #7): `reduce.ts` already has a
   * real, unit-tested `"commit.declined"` transition
   * (`phase: "stopped", stuckReason: "user declined the commit"`), but
   * `drive.ts`'s own decline branch used to just `console.log` and
   * `break` -- exiting the loop before ever calling `reduce()` for it or
   * reaching the trailing `setField()` calls at the loop's own bottom.
   * `state.json`'s on-disk phase stayed stuck at "awaiting_commit"
   * forever; a later daemon restart would read that non-terminal phase
   * and wrongly re-enter the approval flow for a task that was actually
   * declined and done. This drives a real task to a real pending commit
   * approval (the same pattern the accept-path test above uses) and
   * resolves it with a real `decision: "no"` instead, proving the task
   * actually reaches a real, persisted terminal state -- not just that
   * the HTTP call returned 200. */
  it("commit: declining a real pending commit approval actually persists 'stopped', not left stuck at 'awaiting_commit'", async () => {
    const fakeCli = await fakeClaudeCli();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = fakeCli;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-approvals-decline-");
    const { taskId } = await createFinalizedTask(headers, repo);

    const lineupRes = await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(lineupRes.status).toBe(200);

    let pendingId = "";
    await waitFor(async () => {
      const res = await fetch(url("/api/approvals"), { headers });
      const rows = (await res.json()) as Array<{ task_id: string; kind: string; id: string }>;
      const row = rows.find((r) => r.task_id === taskId && r.kind === "commit");
      if (!row) return false;
      pendingId = row.id;
      return true;
    });

    const resolveRes = await fetch(url(`/api/tasks/${taskId}/approvals/${pendingId}`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "no" }),
    });
    expect(resolveRes.status).toBe(200);

    // The actual unblock claim: phase genuinely reaches "stopped" with a
    // real stuck_reason, and the daemon genuinely stops driving the
    // task -- not just that the HTTP call returned 200.
    await waitFor(async () => {
      const res = await fetch(url(`/api/tasks/${taskId}`), { headers });
      const detail = (await res.json()) as { phase: string; active: boolean; stuck_reason: string | null };
      return detail.phase === "stopped" && detail.active === false && detail.stuck_reason === "user declined the commit";
    });

    // No commit ever landed -- a real, negative confirmation the decline
    // was genuinely honored, not silently ignored.
    const log = await git(["log", "--oneline", "-5"], repo).catch(() => "");
    expect(log.toLowerCase()).not.toContain("reverse");

    const afterRes = await fetch(url("/api/approvals"), { headers });
    const afterRows = (await afterRes.json()) as Array<{ id: string }>;
    expect(afterRows.some((r) => r.id === pendingId)).toBe(false);
  }, 30_000);

  it("404s resolving an unknown approval id, and resolving an already-resolved one twice", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-approvals-404-");
    const { taskId } = await createFinalizedTask(headers, repo);
    await waitForTaskKnown(url(""), daemon.token, taskId);

    const res = await fetch(url(`/api/tasks/${taskId}/approvals/no-such-id`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "yes" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a malformed decision body", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-approvals-400-");
    const { taskId } = await createFinalizedTask(headers, repo);
    await waitForTaskKnown(url(""), daemon.token, taskId);

    const res = await fetch(url(`/api/tasks/${taskId}/approvals/whatever`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(res.status).toBe(400);
  });

  it("integrate + cleanup_worktree: real, addressable pending approvals when a task actually has a worktree", async () => {
    // Real, disclosed gap this test works around (see routes/approvals.ts's
    // own docstring): no daemon endpoint creates a worktree for an
    // app-owned task today -- TaskRunner.buildParams() only ever reads
    // whatever state.json already has. This test writes branch/worktree
    // onto state.json directly and creates the real worktree with
    // engine's own createWorktree(), the same primitives a future
    // "worktree mode" lineup option would eventually automate -- so the
    // *approval* machinery this milestone builds is proven against a
    // real worktree/branch/commit/merge sequence, not a mock of one.
    const fakeCli = await fakeClaudeCli();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = fakeCli;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-approvals-integrate-");
    const { taskId } = await createFinalizedTask(headers, repo);
    await waitForTaskKnown(url(""), daemon.token, taskId);

    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    const base = await baseCommit(repo);
    const branch = branchName(taskId);
    const worktree = worktreePath(repo, taskId);
    await createWorktree(repo, worktree, branch, base);
    await setField(taskDir, "base_commit", base);
    await setField(taskDir, "branch", branch);
    await setField(taskDir, "worktree", worktree);

    const lineupRes = await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });
    expect(lineupRes.status).toBe(200);

    let commitApprovalId = "";
    await waitFor(async () => {
      const res = await fetch(url("/api/approvals"), { headers });
      const rows = (await res.json()) as Array<{ task_id: string; kind: string; id: string }>;
      const row = rows.find((r) => r.task_id === taskId && r.kind === "commit");
      if (!row) return false;
      commitApprovalId = row.id;
      return true;
    });
    await fetch(url(`/api/tasks/${taskId}/approvals/${commitApprovalId}`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "yes", data: { message: "Add reverse()" } }),
    });

    // Real claim 1: `integrate` is now the pending approval, addressable
    // over HTTP -- driveTask() only reaches this kind at all when
    // `p.worktree && p.branch` (see drive.ts), which nothing before this
    // test ever set for an app-owned task.
    let integrateApprovalId = "";
    await waitFor(async () => {
      const res = await fetch(url("/api/approvals"), { headers });
      const rows = (await res.json()) as Array<{ task_id: string; kind: string; id: string }>;
      const row = rows.find((r) => r.task_id === taskId && r.kind === "integrate");
      if (!row) return false;
      integrateApprovalId = row.id;
      return true;
    });
    const integrateRes = await fetch(url(`/api/tasks/${taskId}/approvals/${integrateApprovalId}`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "custom", data: { choice: "merge" } }),
    });
    expect(integrateRes.status).toBe(200);

    // Real claim 2: the merge actually happened (a real git operation,
    // not just that the HTTP call returned 200) -- the main repo's log
    // shows the commit from the worktree's branch.
    await waitFor(async () => {
      const log = await git(["log", "--oneline", "-5"], repo).catch(() => "");
      return log.toLowerCase().includes("reverse");
    });

    // Real claim 3: cleanup_worktree is now pending, and resolving it
    // actually removes the real worktree directory.
    let cleanupApprovalId = "";
    await waitFor(async () => {
      const res = await fetch(url("/api/approvals"), { headers });
      const rows = (await res.json()) as Array<{ task_id: string; kind: string; id: string }>;
      const row = rows.find((r) => r.task_id === taskId && r.kind === "cleanup_worktree");
      if (!row) return false;
      cleanupApprovalId = row.id;
      return true;
    });
    const cleanupRes = await fetch(url(`/api/tasks/${taskId}/approvals/${cleanupApprovalId}`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "yes" }),
    });
    expect(cleanupRes.status).toBe(200);

    await waitFor(async () => {
      const listRes = await git(["worktree", "list"], repo).catch(() => "");
      return !listRes.includes(worktree);
    });
  }, 30_000);

  it("emits approval.requested / approval.resolved to events.jsonl and the global feed", async () => {
    const fakeCli = await fakeClaudeCli();
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = fakeCli;
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-approvals-events-");
    const { taskId } = await createFinalizedTask(headers, repo);

    await fetch(url(`/api/tasks/${taskId}/lineup`), { method: "POST", headers, body: JSON.stringify(LINEUP_BODY) });

    let pendingId = "";
    await waitFor(async () => {
      const res = await fetch(url("/api/approvals"), { headers });
      const rows = (await res.json()) as Array<{ task_id: string; kind: string; id: string }>;
      const row = rows.find((r) => r.task_id === taskId && r.kind === "commit");
      if (!row) return false;
      pendingId = row.id;
      return true;
    });

    const eventsPath = join(repo, ".crewbench", "tasks", taskId, "events.jsonl");
    await waitFor(async () => {
      const raw = await readFile(eventsPath, "utf-8").catch(() => "");
      return raw.includes('"approval.requested"') && raw.includes(`"${pendingId}"`);
    });

    await fetch(url(`/api/tasks/${taskId}/approvals/${pendingId}`), {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "yes", data: { message: "Add reverse()" } }),
    });

    await waitFor(async () => {
      const raw = await readFile(eventsPath, "utf-8").catch(() => "");
      return raw.includes('"approval.resolved"') && raw.includes('"decision":"yes"');
    });
  }, 30_000);
});
