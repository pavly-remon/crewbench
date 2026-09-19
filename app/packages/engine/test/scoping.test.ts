import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildScopingPrompt, continueScoping, startScoping, tryParseTaskSpec } from "../src/scoping.js";

describe("buildScopingPrompt", () => {
  it("embeds the task text and the task-spec JSON Schema", () => {
    const prompt = buildScopingPrompt("Fix the login redirect bug");
    expect(prompt).toContain("Fix the login redirect bug");
    expect(prompt).toContain("acceptance_criteria");
    expect(prompt).toContain("Ask clarifying questions");
  });

  it("includes the Jira key when given", () => {
    const prompt = buildScopingPrompt("Fix it", "PROJ-123");
    expect(prompt).toContain("PROJ-123");
  });
});

describe("tryParseTaskSpec", () => {
  const validSpec = {
    title: "Fix login redirect",
    description: "Redirects to the wrong page after login.",
    acceptance_criteria: ["Redirects to /dashboard"],
    affected_areas: ["auth"],
    out_of_scope: [],
    needs_design: false,
    constraints: [],
  };

  it("parses a valid task-spec from a plain JSON reply", () => {
    expect(tryParseTaskSpec(JSON.stringify(validSpec))).toEqual(validSpec);
  });

  it("parses a valid task-spec embedded in prose", () => {
    const reply = `Here's the plan:\n\n${JSON.stringify(validSpec)}\n\nLet me know if that looks right.`;
    expect(tryParseTaskSpec(reply)).toEqual(validSpec);
  });

  it("returns null for a clarifying question (no JSON object)", () => {
    expect(tryParseTaskSpec("What page should the user land on after login?")).toBeNull();
  });

  it("returns null for JSON that doesn't match the task-spec shape", () => {
    expect(tryParseTaskSpec(JSON.stringify({ hello: "world" }))).toBeNull();
  });
});

// Integration: a real subprocess round-trip against a fake CLI, proving
// startScoping()/continueScoping() actually drive a session-resuming
// conversation, not just that tryParseTaskSpec() works on canned text.
describe("startScoping / continueScoping (fake CLI)", () => {
  async function fakeClaudeCli(replies: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "crewbench-fakecli-"));
    const path = join(dir, "fake-claude.cjs");
    const script = `#!/usr/bin/env node
const replies = ${JSON.stringify(replies)};
const stateFile = ${JSON.stringify(join(dir, "turn.txt"))};
let turn = 0;
try { turn = Number(require("fs").readFileSync(stateFile, "utf-8")); } catch {}
require("fs").writeFileSync(stateFile, String(turn + 1));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session-1", model: "m" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, status: "SUCCESS", result: replies[turn] ?? replies[replies.length - 1] }));
`;
    await writeFile(path, script, "utf-8");
    await chmod(path, 0o755);
    return path;
  }

  it("startScoping asks a clarifying question, continueScoping finishes with a spec", async () => {
    const validSpec = {
      title: "Fix login redirect",
      description: "Redirects to the wrong page after login.",
      acceptance_criteria: ["Redirects to /dashboard"],
      affected_areas: ["auth"],
      out_of_scope: [],
      needs_design: false,
      constraints: [],
    };
    const cliPath = await fakeClaudeCli(["What page should it redirect to?", JSON.stringify(validSpec)]);
    const savedOverride = process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE;
    process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = cliPath;
    try {
      const first = await startScoping("claude", "m", "none", "Fix the login redirect bug", process.cwd());
      expect(first.ok).toBe(true);
      expect(first.spec).toBeNull();
      expect(first.reply).toContain("What page");
      expect(first.sessionId).toBe("fake-session-1");

      const second = await continueScoping("claude", "m", "none", "It should go to /dashboard", first.sessionId as string, process.cwd());
      expect(second.ok).toBe(true);
      expect(second.spec).toEqual(validSpec);
    } finally {
      if (savedOverride === undefined) delete process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE;
      else process.env.CREWBENCH_CLI_OVERRIDE_CLAUDE = savedOverride;
    }
  });
});
