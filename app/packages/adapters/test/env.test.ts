import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnv } from "../src/env.js";
import type { Cli } from "../src/types.js";

// Ported from tests/test_recursion_and_env.py's child_env coverage (the
// recursion-guard-refuses-to-run check belongs to the engine/runner in a
// future milestone -- it's a whole-process guard, not a per-adapter one).
describe("childEnv", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it("strips other hosts' markers and sets the recursion guard", () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "abc";
    process.env.CODEX_HOME = "/should/be/stripped";
    process.env.COPILOT_MODEL = "should-be-kept-for-copilot";

    const env = childEnv("codex", "developer", "20260101-0000-demo");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CODEX_HOME).toBe("/should/be/stripped"); // codex's own vars kept when cli == codex
    expect(env.COPILOT_MODEL).toBeUndefined(); // copilot's markers stripped for a non-copilot child
    expect(env.CREWBENCH_ROLE).toBe("developer");
    expect(env.CREWBENCH_TASK).toBe("20260101-0000-demo");

    const env2 = childEnv("copilot", "tester", null);
    expect(env2.COPILOT_MODEL).toBe("should-be-kept-for-copilot");
    expect(env2.CODEX_HOME).toBeUndefined();
    expect(env2.CREWBENCH_TASK).toBe("");
  });

  const HOST_MARKERS: Record<Cli, Record<string, string>> = {
    claude: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x" },
    codex: { CODEX_HOME: "/host/codex" },
    agy: { ANTIGRAVITY_DESKTOP_PRIMES: "1" },
    copilot: { COPILOT_MODEL: "gpt" },
  };

  for (const host of Object.keys(HOST_MARKERS) as Cli[]) {
    for (const roleCli of Object.keys(HOST_MARKERS) as Cli[]) {
      it(`4x4 matrix: host=${host} roleCli=${roleCli} never leaks a different host's markers`, () => {
        for (const markers of Object.values(HOST_MARKERS)) {
          for (const key of Object.keys(markers)) delete process.env[key];
        }
        for (const [key, value] of Object.entries(HOST_MARKERS[host])) {
          process.env[key] = value;
        }

        const env = childEnv(roleCli, "developer", "task-1");

        for (const [h, markers] of Object.entries(HOST_MARKERS) as [Cli, Record<string, string>][]) {
          if (h === roleCli) continue;
          for (const key of Object.keys(markers)) {
            expect(env[key], `${key} (host ${h}'s marker) leaked into a ${roleCli} child`).toBeUndefined();
          }
        }
        if (host === roleCli) {
          for (const [key, value] of Object.entries(HOST_MARKERS[host])) {
            expect(env[key]).toBe(value);
          }
        }
        expect(env.CREWBENCH_ROLE).toBe("developer");
        expect(env.CREWBENCH_TASK).toBe("task-1");
      });
    }
  }
});
