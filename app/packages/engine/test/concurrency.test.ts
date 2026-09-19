import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/concurrency.js";

async function newTaskDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "crewbench-concurrency-"));
}

describe("ConcurrencyLimiter", () => {
  it("allows up to the per-CLI limit to run immediately", async () => {
    const limiter = new ConcurrencyLimiter({ claude: 2 });
    await limiter.acquire("claude");
    await limiter.acquire("claude");
    expect(limiter.runningCount("claude")).toBe(2);
    expect(limiter.queuedCount("claude")).toBe(0);
  });

  it("queues a request beyond the limit, and releases wake the next waiter in order", async () => {
    const limiter = new ConcurrencyLimiter({ claude: 1 });
    await limiter.acquire("claude");
    expect(limiter.runningCount("claude")).toBe(1);

    const order: string[] = [];
    const second = limiter.acquire("claude").then(() => order.push("second"));
    const third = limiter.acquire("claude").then(() => order.push("third"));
    // Both queued -- give the event loop a turn to prove neither resolved yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    expect(limiter.queuedCount("claude")).toBe(2);

    await limiter.release("claude"); // frees the first slot -> wakes "second"
    await second;
    expect(order).toEqual(["second"]);
    expect(limiter.queuedCount("claude")).toBe(1);

    await limiter.release("claude"); // wakes "third"
    await third;
    expect(order).toEqual(["second", "third"]);
    expect(limiter.queuedCount("claude")).toBe(0);
  });

  it("defaults to 2 concurrent runs per CLI when unconfigured", async () => {
    const limiter = new ConcurrencyLimiter();
    await limiter.acquire("codex");
    await limiter.acquire("codex");
    expect(limiter.runningCount("codex")).toBe(2);
    let thirdResolved = false;
    const third = limiter.acquire("codex").then(() => {
      thirdResolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(thirdResolved).toBe(false);
    await limiter.release("codex");
    await third;
    expect(thirdResolved).toBe(true);
  });

  it("tracks each CLI's limit independently", async () => {
    const limiter = new ConcurrencyLimiter({ claude: 1, codex: 1 });
    await limiter.acquire("claude");
    await limiter.acquire("codex"); // a different CLI -- must not be blocked by claude's slot
    expect(limiter.runningCount("claude")).toBe(1);
    expect(limiter.runningCount("codex")).toBe(1);
  });

  it("withSlot releases even when the wrapped function throws", async () => {
    const limiter = new ConcurrencyLimiter({ claude: 1 });
    await expect(
      limiter.withSlot("claude", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(limiter.runningCount("claude")).toBe(0);
  });

  it("emits run.queued / run.dequeued events when a taskDir is given", async () => {
    const limiter = new ConcurrencyLimiter({ claude: 1 });
    const taskDir = await newTaskDir();
    await limiter.acquire("claude", taskDir, "developer-r1");
    const waiter = limiter.acquire("claude", taskDir, "tester-r1");
    await new Promise((r) => setTimeout(r, 10));
    await limiter.release("claude");
    await waiter;

    const events = (await readFile(join(taskDir, "events.jsonl"), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    const types = events.map((e) => e.type);
    expect(types).toContain("run.queued");
    expect(types).toContain("run.dequeued");
    expect(events.find((e) => e.type === "run.queued")?.run).toBe("tester-r1");
    expect(events.find((e) => e.type === "run.dequeued")?.run).toBe("tester-r1");
  });

  it("does not emit an event when a slot is immediately available", async () => {
    const limiter = new ConcurrencyLimiter({ claude: 2 });
    const taskDir = await newTaskDir();
    await limiter.acquire("claude", taskDir, "developer-r1");
    expect(existsSync(join(taskDir, "events.jsonl"))).toBe(false);
  });
});
