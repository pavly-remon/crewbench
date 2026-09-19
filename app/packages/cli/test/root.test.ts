import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentsDir, defaultsPath, findRoot, schemaPath } from "../src/root.js";

describe("findRoot", () => {
  const saved = process.env.CREWBENCH_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.CREWBENCH_ROOT;
    else process.env.CREWBENCH_ROOT = saved;
  });

  it("honors CREWBENCH_ROOT when it's a valid root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crewbench-root-"));
    await mkdir(join(dir, "agents"));
    await mkdir(join(dir, "schemas"));
    process.env.CREWBENCH_ROOT = dir;
    expect(findRoot()).toBe(dir);
  });

  it("finds the real monorepo root by walking up from this file (no override)", () => {
    delete process.env.CREWBENCH_ROOT;
    const root = findRoot();
    expect(root.endsWith("crewbench")).toBe(true);
  });

  it("ignores an invalid CREWBENCH_ROOT and falls back to walking up", async () => {
    process.env.CREWBENCH_ROOT = await mkdtemp(join(tmpdir(), "crewbench-invalid-root-"));
    const root = findRoot();
    expect(root.endsWith("crewbench")).toBe(true);
  });
});

describe("path helpers", () => {
  it("build the expected paths under a root", () => {
    expect(schemaPath("/root", "developer")).toBe(join("/root", "schemas", "developer.json"));
    expect(agentsDir("/root")).toBe(join("/root", "agents"));
    expect(defaultsPath("/root")).toBe(join("/root", "config", "defaults.json"));
  });
});
