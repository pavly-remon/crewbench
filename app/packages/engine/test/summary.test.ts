import { describe, expect, it } from "vitest";
import { deterministicSummary, formatDuration, formatRoleLine, summarizeTask, usageSummary } from "../src/summary.js";
import { initialState, reduce } from "../src/reduce.js";

describe("formatDuration", () => {
  it("formats seconds, minutes+seconds, and hours+minutes+seconds", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(372)).toBe("6m12s"); // 6m12s from the lib/dispatch.md §7 example
    expect(formatDuration(100)).toBe("1m40s");
    expect(formatDuration(125)).toBe("2m05s");
    expect(formatDuration(3725)).toBe("1h02m05s");
  });
});

describe("formatRoleLine", () => {
  it("matches lib/dispatch.md §7's example lines exactly", () => {
    expect(formatRoleLine("developer", { runs: 2, duration_s: 372, tokens: null, cost_usd: null, cli: "agy", model: "gemini-3.8-flash" })).toBe(
      "developer · agy gemini-3.8-flash · 2 runs · 6m12s",
    );
    expect(formatRoleLine("tester", { runs: 1, duration_s: 100, tokens: null, cost_usd: null, cli: "host", model: "sonnet" })).toBe(
      "tester · host (sonnet) · 1 run · 1m40s",
    );
    expect(formatRoleLine("code-reviewer", { runs: 1, duration_s: 125, tokens: null, cost_usd: null, cli: "host", model: "opus" })).toBe(
      "code-reviewer · host (opus) · 1 run · 2m05s",
    );
  });
});

describe("usageSummary", () => {
  it("matches lib/dispatch.md §7's full example, omitting zero-run roles", () => {
    const summary = usageSummary({
      developer: { runs: 2, duration_s: 372, tokens: null, cost_usd: null, cli: "agy", model: "gemini-3.8-flash" },
      tester: { runs: 1, duration_s: 100, tokens: null, cost_usd: null, cli: "host", model: "sonnet" },
      "code-reviewer": { runs: 1, duration_s: 125, tokens: null, cost_usd: null, cli: "host", model: "opus" },
      "ui-ux": { runs: 0, duration_s: null, tokens: null, cost_usd: null, cli: "host", model: "sonnet" },
    });
    expect(summary).toBe(
      [
        "developer · agy gemini-3.8-flash · 2 runs · 6m12s",
        "tester · host (sonnet) · 1 run · 1m40s",
        "code-reviewer · host (opus) · 1 run · 2m05s",
        "total: 4 runs · 9m57s",
      ].join("\n"),
    );
  });
});

describe("deterministicSummary + summarizeTask", () => {
  const usage = { developer: { runs: 1, duration_s: 60, tokens: null, cost_usd: null, cli: "host", model: "sonnet" } };

  it("reports a done task", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = { ...state, phase: "done" };
    const report = deterministicSummary("Fix login", state, usage);
    expect(report).toContain("Fix login: done.");
  });

  it("reports a stopped task's stuck reason", () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 1, fixThreshold: "major" } });
    state = { ...state, phase: "stopped", stuckReason: "gate still failing after 1 rounds" };
    const report = deterministicSummary("Fix login", state, usage);
    expect(report).toContain("Stopped: gate still failing after 1 rounds.");
  });

  it("summarizeTask falls back to the deterministic report when no LLM call is given", async () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = { ...state, phase: "done" };
    const report = await summarizeTask("Fix login", state, usage);
    expect(report).toBe(deterministicSummary("Fix login", state, usage));
  });

  it("summarizeTask uses the LLM's prose when the call succeeds", async () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = { ...state, phase: "done" };
    const report = await summarizeTask("Fix login", state, usage, async () => "All done, login works now.");
    expect(report).toBe("All done, login works now.");
  });

  it("summarizeTask falls back to deterministic when the LLM call throws", async () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = { ...state, phase: "done" };
    const report = await summarizeTask("Fix login", state, usage, async () => {
      throw new Error("network error");
    });
    expect(report).toBe(deterministicSummary("Fix login", state, usage));
  });

  it("summarizeTask falls back to deterministic when the LLM call returns empty", async () => {
    let state = reduce(initialState(), { type: "start", needsDesign: false, loop: { maxRounds: 3, fixThreshold: "major" } });
    state = { ...state, phase: "done" };
    const report = await summarizeTask("Fix login", state, usage, async () => "   ");
    expect(report).toBe(deterministicSummary("Fix login", state, usage));
  });
});
