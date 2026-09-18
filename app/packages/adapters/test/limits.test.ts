import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { agyCommandRules } from "../src/limits.js";

function writeSettings(home: string, rules: unknown[]): void {
  const dir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { allow: rules } }));
}

// Ported from tests/test_agy_rules.py.
describe("agyCommandRules", () => {
  it("splits usable and broken rules", () => {
    const home = mkdtempSync(join(tmpdir(), "crewbench-agy-"));
    writeSettings(home, [
      "command(npm test)",
      "command(ls)",
      "command(ls*)", // broken: agy never matches a trailing *
      "command(*)", // the one wildcard form that does work
      "command(regex:npm run (build|lint))",
      "not-a-command-rule", // ignored, not command(...)
    ]);
    const { usable, broken } = agyCommandRules(home);
    expect(usable).toContain("npm test");
    expect(usable).toContain("ls");
    expect(usable).toContain("*");
    expect(usable).toContain("regex:npm run (build|lint)");
    expect(broken).toContain("command(ls*)");
    expect(usable).not.toContain("ls*");
  });

  it("returns empty when no settings file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "crewbench-agy-"));
    const { usable, broken } = agyCommandRules(home);
    expect(usable).toEqual([]);
    expect(broken).toEqual([]);
  });

  it("returns empty for malformed settings JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "crewbench-agy-"));
    const dir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{not json");
    const { usable, broken } = agyCommandRules(home);
    expect(usable).toEqual([]);
    expect(broken).toEqual([]);
  });
});
