import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/server.js";
import { gitRepo } from "./helpers.js";

describe("GET/PUT /api/projects/:pid/profile (Phase 3 milestone 4)", () => {
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

  async function addProject(headers: Record<string, string>, repo?: string): Promise<{ id: string; path: string }> {
    const path = repo ?? (await gitRepo("crewbench-profile-"));
    const addRes = await fetch(url("/api/projects"), { method: "POST", headers, body: JSON.stringify({ path } ) });
    return (await addRes.json()) as { id: string; path: string };
  }

  it("returns 404 when no profile has been confirmed yet", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const project = await addProject(headers);

    const res = await fetch(url(`/api/projects/${project.id}/profile`), { headers });
    expect(res.status).toBe(404);
  });

  it("?refresh=1 runs a real, unsaved detection against the project's actual files", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const repo = await gitRepo("crewbench-profile-detect-");
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "vitest run", lint: "eslint ." } }),
    );
    const project = await addProject(headers, repo);

    const res = await fetch(url(`/api/projects/${project.id}/profile?refresh=1`), { headers });
    expect(res.status).toBe(200);
    const detected = (await res.json()) as { languages: string[]; commands: { test: string | null }; confirmed: boolean };
    expect(detected.languages).toContain("javascript");
    expect(detected.commands.test).toBe("npm run test");
    expect(detected.confirmed).toBe(false); // never saved, this is a live proposal only

    // Still 404 on a plain GET -- the refresh above must not have saved anything.
    const plainRes = await fetch(url(`/api/projects/${project.id}/profile`), { headers });
    expect(plainRes.status).toBe(404);
  });

  it("PUT rejects a profile without confirmed: true", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const project = await addProject(headers);

    const res = await fetch(url(`/api/projects/${project.id}/profile`), {
      method: "PUT",
      headers,
      body: JSON.stringify({
        package_manager: null,
        install: null,
        commands: {},
        test_patterns: [],
        source_dirs: [],
        languages: [],
        frameworks: [],
        agy_allow_rules: [],
        confirmed: false,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT saves a confirmed (possibly edited) profile, real file on disk, readable afterward", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    const project = await addProject(headers);

    const profile = {
      package_manager: "pnpm",
      install: "pnpm install",
      commands: { lint: "pnpm lint", typecheck: null, test: "pnpm test", test_changed: null, build: null, format_check: null },
      test_patterns: ["*.test.ts"],
      source_dirs: ["src"],
      languages: ["typescript"],
      frameworks: [],
      agy_allow_rules: [],
      confirmed: true,
    };
    const putRes = await fetch(url(`/api/projects/${project.id}/profile`), { method: "PUT", headers, body: JSON.stringify(profile) });
    expect(putRes.status).toBe(200);
    const saved = (await putRes.json()) as { confirmed: boolean; detected_at: string };
    expect(saved.confirmed).toBe(true);
    expect(typeof saved.detected_at).toBe("string"); // stamped server-side since the body didn't include one

    const getRes = await fetch(url(`/api/projects/${project.id}/profile`), { headers });
    expect(getRes.status).toBe(200);
    const read = (await getRes.json()) as { package_manager: string };
    expect(read.package_manager).toBe("pnpm");
  });

  it("returns 404 for an unknown project id", async () => {
    daemon = await startDaemon({ port: 0 });
    const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
    expect((await fetch(url("/api/projects/does-not-exist/profile"), { headers })).status).toBe(404);
  });
});
