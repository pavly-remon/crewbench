import { describe, expect, it } from "vitest";
import { createAdapter } from "../src/adapter.js";
import { CLI_NAMES } from "../src/types.js";

describe("createAdapter", () => {
  for (const cli of CLI_NAMES) {
    it(`assembles a CliAdapter for ${cli}`, () => {
      const adapter = createAdapter(cli);
      expect(adapter.cli).toBe(cli);
      const stream = adapter.newStream();
      expect(stream.cli).toBe(cli);
      expect(adapter.resumeCommand("abc")).toContain("abc");
      if (cli !== "copilot") {
        expect(adapter.resumeCommand(null)).toBeNull();
      }
    });
  }
});
