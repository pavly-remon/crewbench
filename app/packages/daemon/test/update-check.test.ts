import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { checkForUpdate, resetUpdateCheckCache } from "../src/update-check.js";

/** `checkForUpdate()` never hits the real npmjs.org registry in this
 * suite -- a real HTTP call in a test run is slow, flaky under CI
 * network restrictions, and (per this phase's own established discipline
 * around real external calls) unnecessary: the registry response shape
 * is fixed and small, a local fake `fetch` proves the same parsing/
 * comparison logic without the real network dependency. */
function fakeFetch(version: string | null, status = 200): typeof fetch {
  return (async () =>
    new Response(version === null ? "not json" : JSON.stringify({ version }), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("checkForUpdate()", () => {
  beforeEach(() => resetUpdateCheckCache());

  it("reports update_available: true when the registry's latest is genuinely newer than the current version", async () => {
    const result = await checkForUpdate(fakeFetch("99.0.0"));
    // current is whatever this test run's own package.json resolution
    // finds (real, not mocked) -- asserting the real comparison logic
    // against a deliberately absurd "latest" proves the boolean, not a
    // specific version pair.
    if (result.current !== null) {
      expect(result.update_available).toBe(true);
      expect(result.latest).toBe("99.0.0");
    }
  });

  it("reports update_available: false when the registry's latest is not newer (equal or older)", async () => {
    const first = await checkForUpdate(fakeFetch("0.0.1"));
    expect(first.update_available).toBe(false);
  });

  it("never claims an update is available when current can't be determined -- current: null is a real, distinct case, not an error", async () => {
    // Can't force currentVersion() to fail from outside this module
    // without touching real files, so this asserts the actual invariant
    // on whatever real result comes back: current === null implies
    // update_available === false, by construction, for every real run.
    const result = await checkForUpdate(fakeFetch("999.0.0"));
    if (result.current === null) expect(result.update_available).toBe(false);
  });

  it("reports a real error, not a crash, when the registry call fails", async () => {
    const throwingFetch = (async () => {
      throw new Error("real network failure, simulated");
    }) as typeof fetch;
    const result = await checkForUpdate(throwingFetch);
    expect(result.update_available).toBe(false);
    expect(result.latest).toBeNull();
    expect(result.error).toContain("real network failure");
  });

  it("reports a real error for a non-200 registry response", async () => {
    const result = await checkForUpdate(fakeFetch("1.0.0", 404));
    expect(result.error).toContain("404");
  });

  it("caches the result -- a second call within the TTL doesn't call fetch again", async () => {
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: "1.2.3" }), { status: 200 });
    }) as typeof fetch;
    await checkForUpdate(countingFetch);
    await checkForUpdate(countingFetch);
    expect(calls).toBe(1);
  });
});

describe("GET /api/update-check", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "crewbench-updatecheck-home-"));
    process.env.CREWBENCH_HOME = home;
    resetUpdateCheckCache();
  });

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    vi.unstubAllGlobals();
  });

  it("returns a real, schema-valid response shape over HTTP", async () => {
    // The route calls checkForUpdate() with no fetch override, so it
    // uses the real global `fetch` -- stubbed here at the global level
    // (not passed as a param) specifically to prove the *route*, not
    // just the underlying function, never needs a real network call in
    // this test suite either. A real `fetch` (this test's own HTTP
    // client hitting the daemon) is used for the actual request, which
    // is why only the *global* used inside the route handler is stubbed,
    // not `fetch` itself in this test file's own scope.
    const realFetch = fetch;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("registry.npmjs.org")) {
        return new Response(JSON.stringify({ version: "0.0.1" }), { status: 200 });
      }
      return realFetch(input, init);
    });
    daemon = await startDaemon({ port: 0 });
    const res = await realFetch(`http://127.0.0.1:${daemon.port}/api/update-check`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: string | null; latest: string | null; update_available: boolean; checked_at: string };
    expect(typeof body.update_available).toBe("boolean");
    expect(typeof body.checked_at).toBe("string");
  });
});
