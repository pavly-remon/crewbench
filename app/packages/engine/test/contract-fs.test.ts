import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteJson } from "../src/contract-fs.js";

describe("atomicWriteJson", () => {
  it("supports concurrent writes to the same path without sharing temporary files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crewbench-atomic-write-"));
    const path = join(dir, "status.json");
    const values = Array.from({ length: 32 }, (_, index) => ({ index }));

    await Promise.all(values.map((value) => atomicWriteJson(path, value)));

    const result = JSON.parse(await readFile(path, "utf-8")) as { index: number };
    expect(values).toContainEqual(result);
    expect(await readdir(dir)).toEqual(["status.json"]);
  });
});
