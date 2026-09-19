import { describe, expect, it } from "vitest";
import { checkArgvSize, MAX_ARGV_BYTES } from "../src/argv.js";

describe("checkArgvSize", () => {
  it("passes for normal-sized arguments", () => {
    expect(() => checkArgvSize(["claude", "-p", "hello"])).not.toThrow();
  });

  it("throws for an oversized argument", () => {
    const huge = "x".repeat(MAX_ARGV_BYTES + 1);
    expect(() => checkArgvSize(["agy", huge])).toThrow(/E2BIG/);
  });
});
