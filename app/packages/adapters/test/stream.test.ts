import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Stream, classifyLogEntry } from "../src/stream.js";
import { parseOutput } from "../src/parse-output.js";

// Ported from tests/test_stream_parsers.py -- same fixture files (repo-root
// tests/fixtures/), same cases, so both language ports stay provably in
// sync with each other and with a real captured/confirmed shape.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "..", "..", "..", "..", "tests", "fixtures");

function feedAll(stream: Stream, path: string): string[] {
  const lines: string[] = [];
  for (const line of readFileSync(resolve(FIXTURES, path), "utf-8").split("\n")) {
    lines.push(...stream.feed(line));
  }
  return lines;
}

describe("claude stream parser", () => {
  it("parses the claude_stream.jsonl fixture", () => {
    const stream = new Stream("claude");
    const logLines = feedAll(stream, "claude_stream.jsonl");
    expect(stream.sessionId).toBe("c1a2b3c4-0000-0000-0000-000000000001");
    expect(stream.final).not.toBeNull();
    expect((stream.final as Record<string, any>).structured_output.status).toBe("done");
    expect(logLines.some((l) => l.includes("says:"))).toBe(true);
    expect(logLines.some((l) => l.includes("tool: Read"))).toBe(true);
    expect(logLines.some((l) => l.includes("error:"))).toBe(true);

    const { result, error } = parseOutput("claude", stream, "", null);
    expect(error).toBeNull();
    expect((result as Record<string, any>).files_changed).toEqual(["src/calc.py"]);
  });

  it("has no result event -> an error", () => {
    const stream = new Stream("claude");
    stream.feed('{"type": "system", "subtype": "init", "session_id": "x", "model": "sonnet"}');
    const { result, error } = parseOutput("claude", stream, "", null);
    expect(result).toBeNull();
    expect(error).toBe("no result event in output");
  });
});

describe("agy stream parser", () => {
  it("captures a denied command from agy_stream.jsonl", () => {
    const stream = new Stream("agy");
    feedAll(stream, "agy_stream.jsonl");
    expect(stream.sessionId).toBe("a1b2c3d4-0000-0000-0000-000000000002");
    expect(stream.deniedCommands).toEqual(["npm test"]);
    expect((stream.final as Record<string, any>).structured_output.status).toBe("blocked");

    const { result, error } = parseOutput("agy", stream, "", null);
    expect(error).toBeNull();
    expect((result as Record<string, any>).status).toBe("blocked");
  });
});

describe("codex stream parser", () => {
  it("parses the codex_stream.jsonl fixture (real, captured live)", () => {
    const stream = new Stream("codex");
    const logLines = feedAll(stream, "codex_stream.jsonl");
    expect(stream.sessionId).toBe("01a0b679-e908-70d1-8ab6-f1c95fc49c42");
    expect(logLines.some((l) => l.startsWith("says:"))).toBe(true);
    expect(logLines.some((l) => l.startsWith("tool: shell"))).toBe(true);
    expect((stream.final as Record<string, any>).usage.input_tokens).toBe(30712);

    // The --output-schema/-o file, not the stream, is the source of truth
    // for the structured result -- confirm the stream alone doesn't produce one.
    const { error } = parseOutput("codex", stream, "", null);
    expect(error).toBe("no result event in output");
  });

  it("classifies a tool error correctly", () => {
    const stream = new Stream("codex");
    stream.feed('{"type": "thread.started", "thread_id": "t1"}');
    const [line] = stream.feed(
      '{"type": "item.completed", "item": {"id": "i1", "type": "command_execution", ' +
        '"command": "touch /etc/x", "exit_code": 1, "aggregated_output": "Operation not permitted"}}',
    );
    expect(line).toBeDefined();
    expect(classifyLogEntry(line as string)).toBe("run.tool_error");
  });

  it("surfaces a turn.failed error when no last-message file exists", () => {
    const stream = new Stream("codex");
    stream.feed('{"type": "thread.started", "thread_id": "t1"}');
    stream.feed('{"type": "turn.failed", "error": {"message": "model not supported"}}');
    const { result, error } = parseOutput("codex", stream, "", null);
    expect(result).toBeNull();
    expect(error).toBe("model not supported");
  });
});

describe("copilot output extraction", () => {
  it("extracts JSON embedded in plain-text stdout", () => {
    const stream = new Stream("copilot");
    const stdout = readFileSync(resolve(FIXTURES, "copilot_stdout.txt"), "utf-8");
    const { result, error } = parseOutput("copilot", stream, stdout, null);
    expect(error).toBeNull();
    expect((result as Record<string, any>).status).toBe("done");
    expect((result as Record<string, any>).files_changed).toEqual(["src/calc.py"]);
  });
});

describe("classifyLogEntry", () => {
  it("classifies every prefix form", () => {
    expect(classifyLogEntry("says: hello")).toBe("run.message");
    expect(classifyLogEntry("tool: Bash {'command': 'ls'}")).toBe("run.tool_call");
    expect(classifyLogEntry("  error: boom")).toBe("run.tool_error");
    expect(classifyLogEntry("tool: Shell {}  -> denied")).toBe("run.tool_error");
    expect(classifyLogEntry("session started (m) id=abc")).toBe("run.message");
  });
});
