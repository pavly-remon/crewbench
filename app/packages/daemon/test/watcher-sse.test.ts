import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, TextDecoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, createTask, makeTaskId } from "@crewbench/engine";
import { startDaemon, type DaemonHandle } from "../src/server.js";

const execFileAsync = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-watcher-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "hello\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parses `data: {...}` fields out of raw SSE text -- enough for this
 * test's purposes without a full SSE client library. */
function parseDataLines(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("data: ")) out.push(JSON.parse(line.slice("data: ".length)));
  }
  return out;
}

/** Reads from `reader` until `predicate(bufferedText)` is true or
 * `timeoutMs` elapses, returning whatever text has accumulated either
 * way. **Never has more than one `reader.read()` call outstanding at
 * once** -- an earlier version of this helper raced each `read()`
 * against a short per-iteration `sleep()` and, on a timeout, looped back
 * and issued a *second* `read()` while the first was still pending. Per
 * the Streams spec each call still resolves on its own, but
 * `Promise.race()` only returns whichever settles first and silently
 * discards the other's value -- so a chunk that arrived just after one
 * 50ms slice's timeout won was read off the stream and then thrown away,
 * never appearing in `buffered`. A real bug this caused: the SSE tests
 * below intermittently saw a live-appended event "disappear" even though
 * the daemon had sent it correctly (confirmed by hand against the real
 * built daemon with a standalone script before concluding this was a
 * test-helper bug, not a daemon bug). Fixed by using exactly one
 * outstanding `read()` at a time, raced only against a single
 * whole-call deadline. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  predicate: (text: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  let buffered = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(buffered)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const outcome = await Promise.race([
      reader.read().then((r) => ({ kind: "read" as const, ...r })),
      sleep(remaining).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "timeout") break;
    if (outcome.done) break;
    buffered += decoder.decode(outcome.value, { stream: true });
  }
  return buffered;
}

describe("daemon watcher + SSE", () => {
  let daemon: DaemonHandle;
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-watcher-home-"));
    process.env.CREWBENCH_HOME = home;
    daemon = await startDaemon({ port: 0 });
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }
  function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${daemon.token}`, ...extra };
  }

  /** Polls the per-task SSE route until the watcher's task index knows
   * about `taskId` (a plain 200 vs. the "unknown task" 404), instead of a
   * fixed sleep -- a flat sleep here was flaky under load (other
   * workspace packages' test runs contending for CPU during `pnpm -r
   * test` made chokidar's own debounce+dispatch occasionally take longer
   * than a fixed budget), while polling adapts to however long it
   * actually takes on the machine running it. Each probe opens and
   * immediately cancels the stream -- only the response status matters
   * here. */
  async function waitForTaskKnown(taskId: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await fetch(url(`/api/tasks/${taskId}/events`), { headers: authHeaders() });
      res.body?.cancel().catch(() => {});
      if (res.status !== 404) return;
      if (Date.now() > deadline) throw new Error(`watcher never learned about task ${taskId} within ${timeoutMs}ms`);
      await sleep(100);
    }
  }

  /** Simulates a plugin process appending real events to a real task's
   * events.jsonl -- the phase prompt's own acceptance bar ("simulate a
   * plugin writing files, and assert the SSE output"), not a mocked
   * event source. */
  async function registerProjectWithTask(): Promise<{ pid: string; taskId: string; taskDir: string }> {
    const repo = await gitRepo();
    const addRes = await fetch(url("/api/projects"), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: repo }),
    });
    const project = (await addRes.json()) as { id: string };

    const taskId = makeTaskId("watch this task");
    const taskDir = join(repo, ".crewbench", "tasks", taskId);
    await createTask(taskDir, { id: taskId, command: "new-task", title: "Watch this task" });
    // Registering the project happens before the task exists on disk in a
    // real run too (task creation is itself a later step) -- wait for the
    // watcher's chokidar instance to actually observe the new task rather
    // than assuming a fixed delay is enough (see waitForTaskKnown's
    // docstring).
    await waitForTaskKnown(taskId);
    return { pid: project.id, taskId, taskDir };
  }

  it("streams a live-appended event over the per-task SSE endpoint", async () => {
    const { taskId, taskDir } = await registerProjectWithTask();

    const controller = new AbortController();
    const res = await fetch(url(`/api/tasks/${taskId}/events`), { headers: authHeaders(), signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the initial replay (task.created, from createTask() above).
    let buffered = await readUntil(reader, decoder, (text) => parseDataLines(text).length >= 1);
    const initialEvents = parseDataLines(buffered) as Array<{ type: string }>;
    expect(initialEvents.some((e) => e.type === "task.created")).toBe(true);

    // Now simulate the plugin (or, equally, this app's own runner)
    // appending a real run.started event mid-task, exactly the shape
    // this milestone's watcher/tailer has to pick up live.
    await appendEvent(taskDir, "run.started", { role: "developer", cli: "claude", model: "sonnet", effort: "medium" }, "developer-r1");

    buffered = await readUntil(reader, decoder, (text) => parseDataLines(text).some((e) => (e as { type: string }).type === "run.started"));
    const allEvents = parseDataLines(buffered) as Array<{ type: string; data: { role: string } }>;
    const runStarted = allEvents.find((e) => e.type === "run.started");
    expect(runStarted?.data.role).toBe("developer");

    controller.abort();
    reader.cancel().catch(() => {});
  }, 20_000);

  it("returns 404 for an SSE connection to an unknown task id", async () => {
    const res = await fetch(url("/api/tasks/does-not-exist/events"), { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("a reconnect with Last-Event-ID replays exactly the missed events, no duplicates and no gaps", async () => {
    const { taskId, taskDir } = await registerProjectWithTask();
    await appendEvent(taskDir, "task.note_added", { note: "first" }, null);
    await appendEvent(taskDir, "task.note_added", { note: "second" }, null);
    await sleep(400); // let the watcher tail both appends before we read history directly

    // First connection: read everything, remember the last seq seen.
    const first = await fetch(url(`/api/tasks/${taskId}/events`), { headers: authHeaders() });
    const reader1 = first.body!.getReader();
    const decoder = new TextDecoder();
    const text1 = await readUntil(reader1, decoder, (text) => parseDataLines(text).length >= 3);
    reader1.cancel().catch(() => {});
    const events1 = parseDataLines(text1) as Array<{ seq: number; type: string }>;
    expect(events1.map((e) => e.type)).toEqual(["task.created", "task.note_added", "task.note_added"]);
    const lastSeq = Math.max(...events1.map((e) => e.seq));

    // A third event happens while "disconnected".
    await appendEvent(taskDir, "task.note_added", { note: "third" }, null);
    await sleep(400);

    // Reconnect with Last-Event-ID = lastSeq: must get exactly the third note, nothing already seen.
    const second = await fetch(url(`/api/tasks/${taskId}/events`), {
      headers: authHeaders({ "Last-Event-ID": String(lastSeq) }),
    });
    const reader2 = second.body!.getReader();
    const text2 = await readUntil(reader2, decoder, (text) => parseDataLines(text).length >= 1);
    reader2.cancel().catch(() => {});
    const events2 = parseDataLines(text2) as Array<{ seq: number; type: string; data: { note: string } }>;
    expect(events2).toHaveLength(1);
    expect(events2[0]?.data.note).toBe("third");
    expect(events2[0]!.seq).toBeGreaterThan(lastSeq);
  }, 20_000);

  it("global /api/events surfaces task-level events but not run.message noise", async () => {
    const { taskId, taskDir } = await registerProjectWithTask();

    const controller = new AbortController();
    const res = await fetch(url("/api/events"), { headers: authHeaders(), signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    await appendEvent(taskDir, "run.started", { role: "developer", cli: "claude", model: "sonnet", effort: "medium" }, "developer-r1");
    await appendEvent(taskDir, "run.message", { text: "noisy tool output" }, "developer-r1");

    const buffered = await readUntil(reader, decoder, (text) =>
      parseDataLines(text).some((e) => (e as { event: { type: string } }).event.type === "run.started"),
    );
    controller.abort();
    reader.cancel().catch(() => {});

    const globalEvents = parseDataLines(buffered) as Array<{ taskId: string; event: { type: string } }>;
    expect(globalEvents.some((e) => e.taskId === taskId && e.event.type === "run.started")).toBe(true);
    expect(globalEvents.some((e) => e.event.type === "run.message")).toBe(false);
  }, 20_000);
});
