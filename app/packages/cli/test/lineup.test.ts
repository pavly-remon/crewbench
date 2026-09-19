import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLineup } from "../src/lineup.js";

const DEFAULTS = {
  roles: {
    developer: { cli: "host", model: "cheap", effort: "medium", permissions: "skip" },
    tester: { cli: "host", model: "strong", effort: "medium", permissions: "safe" },
    "code-reviewer": { cli: "host", model: "strong", effort: "medium", permissions: "safe" },
    "ui-ux": { cli: "host", model: "cheap", effort: "medium", permissions: "safe" },
  },
  tiers: {
    claude: { cheap: "sonnet", strong: "opus" },
    codex: { cheap: "gpt-5.6-terra", strong: "gpt-5.6-sol" },
    agy: { cheap: "gemini-3.8-flash", strong: "gemini-3.1-pro" },
    copilot: { cheap: "claude-sonnet-5", strong: "claude-opus-5" },
  },
  loop: { max_rounds: 3, fix_threshold: "major" },
  confirm_lineup: "when_unsaved",
  workspace: { mode: "worktree", setup: [], copy: [".env", ".env.local"] },
};

async function writeDefaults(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-defaults-"));
  const path = join(dir, "defaults.json");
  await writeFile(path, JSON.stringify(DEFAULTS), "utf-8");
  return path;
}

async function newProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "crewbench-project-"));
}

describe("resolveLineup", () => {
  it("resolves `host` to the given lead CLI and tiers to real model names", async () => {
    const defaultsPath = await writeDefaults();
    const projectRoot = await newProjectRoot();
    const lineup = await resolveLineup(defaultsPath, projectRoot, "claude");
    expect(lineup.roles.developer).toEqual({ cli: "claude", model: "sonnet", effort: "medium", permissions: "skip" });
    expect(lineup.roles.tester).toEqual({ cli: "claude", model: "opus", effort: "medium", permissions: "safe" });
    expect(lineup.loop).toEqual({ maxRounds: 3, fixThreshold: "major" });
    expect(lineup.workspace.mode).toBe("worktree");
  });

  it("a saved team.json overrides the defaults", async () => {
    const defaultsPath = await writeDefaults();
    const projectRoot = await newProjectRoot();
    await mkdir(join(projectRoot, ".crewbench"), { recursive: true });
    await writeFile(
      join(projectRoot, ".crewbench", "team.json"),
      JSON.stringify({ roles: { developer: { cli: "agy", model: "gemini-3.8-flash" } }, loop: { max_rounds: 5 } }),
      "utf-8",
    );
    const lineup = await resolveLineup(defaultsPath, projectRoot, "claude");
    expect(lineup.roles.developer.cli).toBe("agy");
    expect(lineup.roles.developer.model).toBe("gemini-3.8-flash");
    expect(lineup.loop.maxRounds).toBe(5);
    // Unrelated roles still fall back to the defaults.
    expect(lineup.roles.tester.cli).toBe("claude");
  });

  it("--dev / --review / --rounds override both team.json and the defaults", async () => {
    const defaultsPath = await writeDefaults();
    const projectRoot = await newProjectRoot();
    const lineup = await resolveLineup(defaultsPath, projectRoot, "claude", {
      dev: { cli: "codex", model: "gpt-5.6-sol" },
      review: { cli: "agy" },
      rounds: 7,
    });
    expect(lineup.roles.developer).toEqual({ cli: "codex", model: "gpt-5.6-sol", effort: "medium", permissions: "skip" });
    expect(lineup.roles["code-reviewer"].cli).toBe("agy");
    // --review without a model keeps the role's already-resolved model.
    expect(lineup.roles["code-reviewer"].model).toBe("opus");
    expect(lineup.loop.maxRounds).toBe(7);
  });

  it("passes an exact model name through unchanged (not a cheap/strong tier)", async () => {
    const defaultsPath = await writeDefaults();
    const projectRoot = await newProjectRoot();
    await mkdir(join(projectRoot, ".crewbench"), { recursive: true });
    await writeFile(
      join(projectRoot, ".crewbench", "team.json"),
      JSON.stringify({ roles: { developer: { model: "claude-opus-4-1-20250805" } } }),
      "utf-8",
    );
    const lineup = await resolveLineup(defaultsPath, projectRoot, "claude");
    expect(lineup.roles.developer.model).toBe("claude-opus-4-1-20250805");
  });

  it("falls back sensibly when defaults.json is missing", async () => {
    const projectRoot = await newProjectRoot();
    const lineup = await resolveLineup(join(projectRoot, "no-such-defaults.json"), projectRoot, "claude");
    expect(lineup.roles.developer.cli).toBe("claude");
    expect(lineup.loop.maxRounds).toBe(3);
  });
});
