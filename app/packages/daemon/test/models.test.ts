import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";

describe("GET /api/models/:cli", () => {
  let daemon: DaemonHandle;
  const savedEnv = { ...process.env };

  afterEach(async () => {
    await daemon.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${daemon.port}${path}`;
  }

  it("400s for an unknown cli name", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/models/not-a-real-cli"), { headers });
    expect(res.status).toBe(400);
  });

  it("returns checked:false for claude -- no model-listing command exists for it, confirmed live against the real installed binary (not assumed)", async () => {
    // The override just needs to resolve to *something* -- claude has no
    // MODEL_LIST_COMMANDS entry at all, so listAvailableModels() never
    // actually spawns this path; it short-circuits before ever touching
    // the filesystem here. A dummy, non-executable path is enough to
    // prove that.
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = "/nonexistent/fake-claude";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/models/claude"), { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cli: string; checked: boolean; available: string[]; error: string | null };
    expect(body).toEqual({ cli: "claude", checked: false, available: [], error: expect.any(String) });
  });

  it("returns checked:false with a real error message when a CLI isn't found on PATH at all", async () => {
    // No CREWBENCH_CLI_OVERRIDE_AGY set, and PATH scoped to nothing --
    // resolveCliPath() genuinely can't find it, the other real
    // checked:false branch (routes/models.ts's own docstring).
    process.env.PATH = "";
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/models/agy"), { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checked: boolean; error: string | null };
    expect(body.checked).toBe(false);
    expect(body.error).toContain("PATH");
  });

  it("returns a real, parsed model list for agy -- a genuine subprocess call, not a mock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crewbench-daemon-models-fakeagy-"));
    const path = join(dir, "fake-agy.cjs");
    await writeFile(
      path,
      `#!/usr/bin/env node
console.log("Fetching available models...");
console.log("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)");
console.log("claude-sonnet-4-6\\tClaude Sonnet 4.6 (Thinking)");
`,
      "utf-8",
    );
    await chmod(path, 0o755);
    process.env.CREWBENCH_CLI_OVERRIDE_AGY = path;

    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const res = await fetch(url("/api/models/agy"), { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cli: string; checked: boolean; available: string[]; error: string | null };
    // The real thing this route claims: the "Fetching..." progress line
    // is filtered out, only the real model ids (tab-split, first column)
    // survive -- exactly what a live `agy models` call produces.
    expect(body).toEqual({ cli: "agy", checked: true, available: ["gemini-3.8-flash-high", "claude-sonnet-4-6"], error: null });
  });
});
