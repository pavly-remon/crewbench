import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { appendField, createTask, listTasks, loadState, makeSlug, makeTaskId, mutateState, setField } from "../src/task-store.js";

async function newRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "crewbench-store-"));
}

describe("makeSlug / makeTaskId", () => {
  it("slugifies and truncates to 5 words", () => {
    expect(makeSlug("Fix the Login Redirect Bug!! Now")).toBe("fix-the-login-redirect-bug");
  });

  it("ids follow YYYYMMDD-HHMM-<slug>-<4 hex>", () => {
    const id = makeTaskId("hello world");
    const parts = id.split("-");
    expect(parts[0]).toHaveLength(8);
    expect(id.startsWith(`${parts[0]}-${parts[1]}-hello-world-`)).toBe(true);
    const suffix = id.split("-").at(-1) as string;
    expect(suffix).toMatch(/^[0-9a-f]{4}$/);
  });

  it("ids don't collide within the same minute", () => {
    const ids = new Set(Array.from({ length: 200 }, () => makeTaskId("hello world")));
    expect(ids.size).toBeGreaterThan(195);
  });
});

describe("createTask", () => {
  it("creates state.json with the expected defaults and updates index.json", async () => {
    const root = await newRoot();
    const taskDir = join(root, ".crewbench", "tasks", "t1");
    const state = await createTask(taskDir, { id: "t1", command: "new-task", title: "X" });
    expect(state.phase).toBe("scoping");
    expect(state.round).toBe(0);
    expect(state.rounds).toEqual([]);
    expect(state.jira_key).toBeNull();
    expect(state.schema_version).toBe(1);

    const index = JSON.parse(await readFile(join(root, ".crewbench", "index.json"), "utf-8"));
    expect(index.t1.title).toBe("X");

    const events = (await readFile(join(taskDir, "events.jsonl"), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "task.created", data: { command: "new-task", title: "X" } });
  });

  it("stores a Jira key when given", async () => {
    const root = await newRoot();
    const taskDir = join(root, ".crewbench", "tasks", "t2");
    const state = await createTask(taskDir, { id: "t2", command: "new-task", title: "Y", jiraKey: "PROJ-123" });
    expect(state.jira_key).toBe("PROJ-123");
  });
});

describe("setField / appendField", () => {
  it("sets a top-level field and emits task.phase_changed only on an actual change", async () => {
    const root = await newRoot();
    const taskDir = join(root, ".crewbench", "tasks", "t3");
    await createTask(taskDir, { id: "t3", command: "new-task", title: "T" });
    await setField(taskDir, "phase", "implementing");
    await setField(taskDir, "phase", "implementing"); // no-op, same value

    const state = await loadState(taskDir);
    expect(state.phase).toBe("implementing");

    const events = (await readFile(join(taskDir, "events.jsonl"), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    const phaseEvents = events.filter((e) => e.type === "task.phase_changed");
    expect(phaseEvents).toHaveLength(1);
    expect(phaseEvents[0].data).toEqual({ from: "scoping", to: "implementing" });
  });

  it("appends to a list field, creating it if missing, and emits task.note_added", async () => {
    const root = await newRoot();
    const taskDir = join(root, ".crewbench", "tasks", "t4");
    await createTask(taskDir, { id: "t4", command: "review", title: "T" });
    await appendField(taskDir, "notes", "first note");
    const state = await appendField(taskDir, "notes", "second note");
    expect(state.notes).toEqual(["first note", "second note"]);

    const events = (await readFile(join(taskDir, "events.jsonl"), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "task.note_added")).toHaveLength(2);
  });
});

describe("listTasks", () => {
  it("lists tasks newest-first", async () => {
    const root = await newRoot();
    const crewbenchDir = join(root, ".crewbench");
    await createTask(join(crewbenchDir, "tasks", "a"), { id: "a", command: "new-task", title: "A" });
    await new Promise((r) => setTimeout(r, 1100)); // ensure a distinct updated_at second
    await createTask(join(crewbenchDir, "tasks", "b"), { id: "b", command: "new-task", title: "B" });
    const rows = await listTasks(crewbenchDir);
    expect(rows[0]?.id).toBe("b");
    expect(rows[1]?.id).toBe("a");
  });

  it("returns an empty list when index.json doesn't exist", async () => {
    const root = await newRoot();
    expect(await listTasks(join(root, ".crewbench"))).toEqual([]);
  });
});

describe("mutateState concurrency", () => {
  it("N concurrent setField calls on distinct keys all land", async () => {
    const root = await newRoot();
    const taskDir = join(root, ".crewbench", "tasks", "concurrent");
    await createTask(taskDir, { id: "concurrent", command: "new-task", title: "T" });
    const N = 16;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutateState(taskDir, (state) => {
          if (!state) throw new Error("missing");
          return { ...state, [`field${i}`]: i } as typeof state;
        }),
      ),
    );
    const state = await loadState(taskDir);
    for (let i = 0; i < N; i++) {
      expect((state as Record<string, unknown>)[`field${i}`]).toBe(i);
    }
  });
});
