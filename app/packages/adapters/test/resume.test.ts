import { describe, expect, it } from "vitest";
import { resumeCommand } from "../src/resume.js";

describe("resumeCommand", () => {
  it("builds each CLI's resume command", () => {
    expect(resumeCommand("claude", "abc-123")).toBe("claude --resume abc-123");
    expect(resumeCommand("agy", "abc-123")).toBe("agy --conversation abc-123");
    expect(resumeCommand("copilot", "abc-123")).toBe("copilot --resume=abc-123");
  });

  it("uses the headless exec subcommand for codex, not the interactive TUI form", () => {
    // Confirmed live (`codex resume --help` vs `codex exec resume --help`,
    // codex-cli 0.154.0): `codex resume <id>` launches the interactive
    // TUI; the headless equivalent is `codex exec resume <id>`.
    expect(resumeCommand("codex", "abc-123")).toBe("codex exec resume abc-123");
  });

  it("returns null when there is no session id, except copilot", () => {
    expect(resumeCommand("claude", null)).toBeNull();
    expect(resumeCommand("codex", null)).toBeNull();
    expect(resumeCommand("agy", null)).toBeNull();
    expect(resumeCommand("copilot", null)).toBe("copilot --continue");
  });
});
