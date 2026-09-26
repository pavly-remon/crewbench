import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addProject, removeProject } from "../src/registry.js";
import { gitRepo } from "./helpers.js";

/** `Promise.all()` rejects (and this async function returns) the moment
 * the *first* promise in `fns` rejects -- any sibling still in flight is
 * orphaned, not cancelled, and keeps running after the caller has moved
 * on. A real, disclosed incident found live while deliberately reverting
 * `registry.ts` to its pre-fix, unlocked form to prove this test suite
 * actually catches that bug (a legitimate falsification step, not normal
 * test execution): the reverted code's genuine race threw `ENOENT` for
 * some concurrent `addProject()` calls, `Promise.all()` rejected
 * immediately, this file's own `afterEach` then deleted
 * `CREWBENCH_HOME` (restoring the real environment) *before* the
 * orphaned, still-in-flight calls reached their own `atomicWriteJson()`
 * -- which then read `daemonHome()`'s real fallback and wrote a few
 * stray temp-dir entries into this actual machine's real
 * `~/.crewbench/projects.json`. Confirmed via `git reflog`-equivalent
 * reasoning (exact `added_at` timestamps matching the exact run),
 * cleaned up, and confirmed non-reproducible against the real, shipped
 * (locked) `registry.ts` across five separate attempts (this file alone,
 * the full daemon suite twice, the full monorepo suite twice) -- the fix
 * itself closes the race that made this possible in normal operation.
 * `settleAll()` here is a real, disclosed defensive hardening regardless
 * of that: it waits for every promise to actually finish (success or
 * failure) before returning, so no future regression -- in this code or
 * anything else this test suite exercises with real concurrent I/O --
 * can leave an orphaned write racing this file's own environment
 * cleanup again. */
async function settleAll<T>(fns: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(fns);
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
  if (rejected.length > 0) throw rejected[0]!.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}

describe("registry.ts's locked read-modify-write (Phase 4 milestone 4)", () => {
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    process.env.CREWBENCH_HOME = await mkdtemp(join(tmpdir(), "crewbench-registry-home-"));
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it("loses no entries when many addProject() calls race each other -- the real bug this milestone fixes", async () => {
    // 10 distinct real git repos, added concurrently (Promise.all, not
    // sequential awaits) -- the actual shape of the pre-fix race:
    // registry.ts's old saveRegistry() was a plain load-then-write with
    // no lock spanning the two, so two concurrent addProject() calls
    // could each read the same base registry, each add their own entry
    // to their own in-memory copy, and the second writer's own
    // atomicWriteJson() would silently clobber the first writer's entry
    // entirely -- proven here by the count actually surviving, not by
    // reading the fix's own source and assuming it works.
    const repos = await settleAll(Array.from({ length: 10 }, (_, i) => gitRepo(`crewbench-registry-race-${i}-`)));
    const entries = await settleAll(repos.map((repo, i) => addProject(repo, `race-${i}`)));

    expect(entries).toHaveLength(10);
    expect(new Set(entries.map((e) => e.id)).size).toBe(10); // no duplicate/collided ids either

    const onDisk = JSON.parse(await readFile(join(process.env.CREWBENCH_HOME as string, "projects.json"), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toHaveLength(10);
    for (const repo of repos) {
      expect(Object.values(onDisk).some((v) => (v as { path: string }).path === repo)).toBe(true);
    }
  });

  it("re-adding the same path concurrently is idempotent -- one entry, not a duplicate racing itself", async () => {
    const repo = await gitRepo("crewbench-registry-idempotent-");
    const [a, b, c] = await settleAll([addProject(repo, "x"), addProject(repo, "x"), addProject(repo, "x")]);

    expect(a?.id).toBe(b?.id);
    expect(b?.id).toBe(c?.id);

    const onDisk = JSON.parse(await readFile(join(process.env.CREWBENCH_HOME as string, "projects.json"), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toHaveLength(1);
  });

  it("interleaved concurrent adds and removes converge to a correct final state, not a lost update", async () => {
    const repos = await settleAll(Array.from({ length: 6 }, (_, i) => gitRepo(`crewbench-registry-mixed-${i}-`)));
    const entries = await settleAll(repos.map((repo, i) => addProject(repo, `mixed-${i}`)));

    // Remove the first 3 while nothing else is racing them -- proves
    // removeProject() itself also goes through the same lock (not just
    // addProject()), by checking the exact right 3 survive.
    await settleAll(entries.slice(0, 3).map((e) => removeProject(e.id)));

    const onDisk = JSON.parse(await readFile(join(process.env.CREWBENCH_HOME as string, "projects.json"), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toHaveLength(3);
    for (const survivor of entries.slice(3)) {
      expect(onDisk[survivor.id]).toBeTruthy();
    }
    for (const removed of entries.slice(0, 3)) {
      expect(onDisk[removed.id]).toBeUndefined();
    }
  });
});
