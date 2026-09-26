import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Stream } from "../src/stream.js";
import { extractUsage, usageFromText } from "../src/usage.js";

// Ported from tests/test_usage.py.
describe("extractUsage", () => {
  it("claude: pulls usage from the fixture result event", () => {
    const stream = new Stream("claude");
    stream.final = {
      subtype: "success",
      is_error: false,
      status: "SUCCESS",
      num_turns: 6,
      total_cost_usd: 0.0431,
      usage: { input_tokens: 15234, output_tokens: 812 },
    };
    const usage = extractUsage("claude", stream, "", 41.2);
    expect(usage.duration_s).toBe(41.2);
    expect(usage.input_tokens).toBe(15234);
    expect(usage.output_tokens).toBe(812);
    expect(usage.total_tokens).toBe(15234 + 812);
    expect(usage.cost_usd).toBe(0.0431);
    expect(usage.num_turns).toBe(6);
  });

  it("agy: pulls usage from a fixture result event", () => {
    const stream = new Stream("agy");
    stream.final = { num_turns: 2, usage: { input_tokens: 5083, output_tokens: 137, total_tokens: 5220 } };
    const usage = extractUsage("agy", stream, "", 12.5);
    expect(usage.input_tokens).toBe(5083);
    expect(usage.output_tokens).toBe(137);
    expect(usage.total_tokens).toBe(5220);
    expect(usage.num_turns).toBe(2);
    expect(usage.cost_usd).toBeNull();
  });

  it("agy: defaults to null when usage is absent", () => {
    const stream = new Stream("agy");
    stream.final = { structured_output: { status: "done" } };
    const usage = extractUsage("agy", stream, "", 12.5);
    expect(usage.input_tokens).toBeNull();
    expect(usage.output_tokens).toBeNull();
    expect(usage.total_tokens).toBeNull();
    expect(usage.cost_usd).toBeNull();
    expect(usage.num_turns).toBeNull();
  });

  it("codex: pulls real usage from turn.completed", () => {
    const stream = new Stream("codex");
    stream.final = { usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 0, reasoning_output_tokens: 0 } };
    const usage = extractUsage("codex", stream, "", 3.0);
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(25);
    expect(usage.total_tokens).toBe(125);
    expect(usage.cost_usd).toBeNull();
  });

  it("codex: null without a turn.completed event (no text-scan fallback)", () => {
    const stream = new Stream("codex");
    const usage = extractUsage("codex", stream, "done.\nTokens used: 1,234\n", 3.0);
    expect(usage.total_tokens).toBeNull();
  });

  it("copilot: pulls real usage from the --usage-output-file", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewbench-usage-"));
    const usageFile = join(dir, "usage.json");
    writeFileSync(usageFile, JSON.stringify({ lastCallInputTokens: 24525, lastCallOutputTokens: 9, totalNanoAiu: 6140150000 }));
    const stream = new Stream("copilot");
    const usage = extractUsage("copilot", stream, "", 2.0, usageFile);
    expect(usage.input_tokens).toBe(24525);
    expect(usage.output_tokens).toBe(9);
    expect(usage.total_tokens).toBe(24525 + 9);
    expect(usage.cost_usd).toBeNull();
  });

  it("copilot: falls back to a text scan when the usage file is missing", () => {
    const stream = new Stream("copilot");
    const usage = extractUsage("copilot", stream, "done.\nTokens used: 1,234\n", 3.0, "/does/not/exist.json");
    expect(usage.total_tokens).toBe(1234);
  });

  it("copilot: null when no usage file and no text match", () => {
    const stream = new Stream("copilot");
    const usage = extractUsage("copilot", stream, "plain output with no usage info", 2.0, null);
    expect(usage.total_tokens).toBeNull();
    expect(usage.duration_s).toBe(2.0);
  });
});

describe("usageFromText", () => {
  it("matches 'Total tokens:' phrasing", () => {
    expect(usageFromText("Total tokens: 9,001")).toBe(9001);
    expect(usageFromText("no numbers here")).toBeNull();
    expect(usageFromText("")).toBeNull();
  });
});
