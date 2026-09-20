import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiScopingStreamEvent } from "@crewbench/contract";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo } from "./helpers.js";

const VALID_SPEC = {
  title: "Fix login redirect",
  description: "Redirects to the wrong page after login.",
  acceptance_criteria: ["Redirects to /dashboard"],
  affected_areas: ["auth"],
  out_of_scope: [],
  needs_design: false,
  constraints: [],
};

/** Same fake-CLI shape as `packages/engine/test/scoping.test.ts`'s own
 * fixture (a real Node subprocess, resumed via
 * `CREWBENCH_CLI_OVERRIDE_CLAUDE`), reused here so both layers exercise
 * the identical real session-resume contract, just from HTTP down
 * instead of from `startScoping()`/`continueScoping()` down. Its
 * per-call-count `turn.txt` file lives on disk (not in-process memory),
 * so it survives a real daemon process restart -- the actual thing the
 * restart-mid-scoping test below needs. */
async function fakeClaudeCli(replies: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-daemon-fakecli-"));
  const path = join(dir, "fake-claude.cjs");
  const script = `#!/usr/bin/env node
const replies = ${JSON.stringify(replies)};
const stateFile = ${JSON.stringify(join(dir, "turn.txt"))};
let turn = 0;
try { turn = Number(require("fs").readFileSync(stateFile, "utf-8")); } catch {}
require("fs").writeFileSync(stateFile, String(turn + 1));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session-1", model: "m" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: replies[turn] ?? replies[replies.length - 1] }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", result: replies[turn] ?? replies[replies.length - 1] }));
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
  return path;
}

/** Reads one POST-initiated SSE response to completion, returning every
 * frame in order -- mirrors `lib/api.ts`'s `openEventStream()` parsing
 * (id/data lines, `\n\n`-delimited), reimplemented plainly here rather
 * than importing the UI package, which this daemon-only test suite has
 * no dependency on. */
async function readSse(res: Response): Promise<ApiScopingStreamEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const events: ApiScopingStreamEvent[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const parts = buffered.split("\n\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as ApiScopingStreamEvent);
      }
    }
  }
  return events;
}

describe("POST /api/tasks/:tid/scoping/* (Phase 3 milestone 3)", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-scoping-home-"));
    process.env.CREWBENCH_HOME = home;
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  async function setupTask(daemonHandle: DaemonHandle, repo: string): Promise<{ projectId: string; taskId: string }> {
    const headers = { Authorization: `Bearer ${daemonHandle.token}`, "Content-Type": "application/json" };
    const addRes = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: repo }),
    });
    const project = (await addRes.json()) as { id: string };
    const createRes = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task_text: "Fix the login redirect bug" }),
    });
    const detail = (await createRes.json()) as { id: string };
    return { projectId: project.id, taskId: detail.id };
  }

  it("streams a clarifying question, then a finished spec, over two real turns", async () => {
    const cliPath = await fakeClaudeCli(["What page should it redirect to?", JSON.stringify(VALID_SPEC)]);
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = cliPath;
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-scoping-");
    const { taskId } = await setupTask(daemon, repo);
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    const firstRes = await fetch(`http://127.0.0.1:${daemon.port}/api/tasks/${taskId}/scoping/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "Fix the login redirect bug", cli: "claude", model: "m" }),
    });
    expect(firstRes.status).toBe(200);
    const firstEvents = await readSse(firstRes);
    expect(firstEvents.some((e) => e.type === "chunk")).toBe(true);
    const firstDone = firstEvents.find((e) => e.type === "done");
    expect(firstDone).toMatchObject({ ok: true, spec: null, session_id: "fake-session-1" });
    expect((firstDone as { reply: string }).reply).toContain("What page");

    // state.json must have persisted the session/cli/model for the next
    // turn to resume from -- the actual open-question-3 claim.
    const stateAfterFirst = JSON.parse(await readFile(join(repo, ".crewbench", "tasks", taskId, "state.json"), "utf-8")) as {
      scoping_session_id?: string;
      scoping_cli?: string;
      scoping_model?: string;
    };
    expect(stateAfterFirst.scoping_session_id).toBe("fake-session-1");
    expect(stateAfterFirst.scoping_cli).toBe("claude");
    expect(stateAfterFirst.scoping_model).toBe("m");

    // Second turn: no cli/model sent -- must resume via the persisted
    // session, not require the client to keep re-sending them.
    const secondRes = await fetch(`http://127.0.0.1:${daemon.port}/api/tasks/${taskId}/scoping/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "It should go to /dashboard" }),
    });
    expect(secondRes.status).toBe(200);
    const secondEvents = await readSse(secondRes);
    const secondDone = secondEvents.find((e) => e.type === "done") as { ok: boolean; spec: unknown };
    expect(secondDone.ok).toBe(true);
    expect(secondDone.spec).toEqual(VALID_SPEC);
  });

  it("resumes the same underlying CLI session across a real daemon restart mid-scoping", async () => {
    const cliPath = await fakeClaudeCli(["What page should it redirect to?", JSON.stringify(VALID_SPEC)]);
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = cliPath;
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-scoping-restart-");
    const { taskId } = await setupTask(daemon, repo);
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    const firstRes = await fetch(`http://127.0.0.1:${daemon.port}/api/tasks/${taskId}/scoping/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "Fix the login redirect bug", cli: "claude", model: "m" }),
    });
    const firstEvents = await readSse(firstRes);
    expect((firstEvents.find((e) => e.type === "done") as { ok: boolean }).ok).toBe(true);

    // The "restart": close this daemon entirely and start a fresh one --
    // registry.json (under the same CREWBENCH_HOME) is the only thing
    // carried over, exactly as a real `crewbench ui` restart would see.
    await daemon.close();
    daemon = await startDaemon({ port: 0 });
    const headers2 = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    const secondRes = await fetch(`http://127.0.0.1:${daemon.port}/api/tasks/${taskId}/scoping/messages`, {
      method: "POST",
      headers: headers2,
      body: JSON.stringify({ message: "It should go to /dashboard" }),
    });
    expect(secondRes.status).toBe(200);
    const secondEvents = await readSse(secondRes);
    const secondDone = secondEvents.find((e) => e.type === "done") as { ok: boolean; spec: unknown };
    expect(secondDone.ok).toBe(true);
    expect(secondDone.spec).toEqual(VALID_SPEC);
    // Proof it was genuinely the *same* fake-CLI session resumed (turn
    // index 1, not turn 0 again) rather than a fresh conversation: the
    // fake CLI always reports the identical session_id regardless, so
    // the real proof is that the spec came back at all -- a fresh
    // (turn-0) call would have replied with the clarifying question
    // again, not the spec.
  });

  it("returns 400 when the first scoping message omits cli/model", async () => {
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-scoping-badreq-");
    const { taskId } = await setupTask(daemon, repo);
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tasks/${taskId}/scoping/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("finalizes a spec: writes spec.json, sets acceptance_criteria/title, clears scoping_session_id", async () => {
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-scoping-finalize-");
    const { taskId } = await setupTask(daemon, repo);
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tasks/${taskId}/scoping/finalize`, {
      method: "POST",
      headers,
      body: JSON.stringify(VALID_SPEC),
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { title: string; spec: unknown };
    expect(detail.title).toBe(VALID_SPEC.title);
    expect(detail.spec).toEqual(VALID_SPEC);

    const state = JSON.parse(await readFile(join(repo, ".crewbench", "tasks", taskId, "state.json"), "utf-8")) as {
      acceptance_criteria?: string[];
      scoping_session_id?: string | null;
      spec_file?: string;
    };
    expect(state.acceptance_criteria).toEqual(VALID_SPEC.acceptance_criteria);
    expect(state.scoping_session_id ?? null).toBeNull();
    expect(state.spec_file).toBeTruthy();
  });

  it("rejects scoping/finalize for a plugin-owned task", async () => {
    daemon = await startDaemon({ port: 0 });
    const repo = await gitRepo("crewbench-scoping-notowned-");
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const addRes = await fetch(`http://127.0.0.1:${daemon.port}/api/projects`, { method: "POST", headers, body: JSON.stringify({ path: repo }) });
    const project = (await addRes.json()) as { id: string };

    const { createTask, makeTaskId } = await import("@crewbench/engine");
    const taskId = makeTaskId("plugin task");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Plugin task" }); // no owner -> "plugin"
    daemon.watcher.registerTask(project.id, repo, taskId);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/tasks/${taskId}/scoping/finalize`, {
      method: "POST",
      headers,
      body: JSON.stringify(VALID_SPEC),
    });
    expect(res.status).toBe(403);
  });
});
