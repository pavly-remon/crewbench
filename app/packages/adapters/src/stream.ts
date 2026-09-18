import type { Cli, NormalizedEventType } from "./types.js";
import { short } from "./json-extract.js";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns a CLI's output lines into live log lines and remembers what
 * matters. Ported field-for-field from crewbench_dispatch.py's Stream
 * class (see its _claude/_agy/_codex methods for the confirmed-live shapes
 * each branch matches). copilot has no structured stream mode wired here
 * (see docs/compatibility.md's Phase 0 milestone 4 notes on why) -- it
 * falls through to the generic branch below, same as the Python version. */
export class Stream {
  readonly cli: Cli;
  sessionId: string | null = null;
  /** claude/agy/codex's final result event, in whatever shape that CLI's
   * branch below stashes it -- extractUsage()/parseOutput() know each
   * CLI's own shape. */
  final: JsonObject | null = null;
  /** agy commands refused by its permission check. */
  readonly deniedCommands: string[] = [];

  constructor(cli: Cli) {
    this.cli = cli;
  }

  /** Return readable log lines for one output line. */
  feed(line: string): string[] {
    if (this.cli === "claude") return this.claude(line);
    if (this.cli === "agy") return this.agy(line);
    if (this.cli === "codex") return this.codex(line);
    if (this.sessionId === null) {
      const match = /session id:\s*([0-9a-fA-F-]{8,})/.exec(line);
      if (match?.[1]) this.sessionId = match[1];
    }
    return line.trim() ? [line.replace(/\n$/, "")] : [];
  }

  private event(line: string): JsonObject | null {
    try {
      const parsed: unknown = JSON.parse(line);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private claude(line: string): string[] {
    const event = this.event(line);
    if (event === null) return line.trim() ? [line.replace(/\n$/, "")] : [];
    const kind = event.type;
    if (kind === "system" && event.subtype === "init") {
      this.sessionId = typeof event.session_id === "string" ? event.session_id : null;
      return [`session started (${event.model ?? ""}) id=${this.sessionId ?? ""}`];
    }
    if (kind === "result") {
      this.final = event;
      return [`finished: ${event.subtype ?? ""}`];
    }
    const out: string[] = [];
    const message = isPlainObject(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (kind === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push("says: " + short(block.text));
      } else if (kind === "assistant" && block.type === "tool_use") {
        out.push(`tool: ${block.name as string} ${short(block.input ?? {})}`);
      } else if (kind === "user" && block.type === "tool_result" && block.is_error) {
        out.push("  error: " + short(block.content ?? ""));
      }
    }
    return out;
  }

  private agy(line: string): string[] {
    const event = this.event(line);
    if (event === null) return line.trim() ? [line.replace(/\n$/, "")] : [];
    const kind = event.event;
    if (kind === "init") {
      const init = isPlainObject(event.init) ? event.init : {};
      this.sessionId = typeof event.conversation_id === "string" ? event.conversation_id : null;
      return [`session started (${init.model ?? ""}) id=${this.sessionId ?? ""}`];
    }
    if (kind === "result") {
      this.final = isPlainObject(event.result) ? event.result : {};
      return [`finished: ${this.final.status ?? ""}`];
    }
    const step = isPlainObject(event.step_update) ? event.step_update : {};
    if (step.step_type !== "tool" || step.state === "ACTIVE") return [];
    const info = isPlainObject(step.tool_info) ? step.tool_info : {};
    let text = `tool: ${step.tool_name as string} ${short(info.parameters ?? {})}`;
    if (step.state === "ERROR") {
      const error = isPlainObject(info.error) ? info.error : {};
      const message = typeof error.message === "string" ? error.message : "error";
      text += "  -> " + short(message);
      const parameters = isPlainObject(info.parameters) ? info.parameters : {};
      const command = parameters.CommandLine;
      if (typeof command === "string" && message.includes("permission check failed")) {
        this.deniedCommands.push(command);
      }
    }
    return [text];
  }

  private codex(line: string): string[] {
    const event = this.event(line);
    if (event === null) return line.trim() ? [line.replace(/\n$/, "")] : [];
    const kind = event.type;
    if (kind === "thread.started") {
      this.sessionId = typeof event.thread_id === "string" ? event.thread_id : null;
      return [`session started id=${this.sessionId ?? ""}`];
    }
    if (kind === "turn.completed") {
      this.final = { usage: isPlainObject(event.usage) ? event.usage : {} };
      return ["finished: turn complete"];
    }
    if (kind === "turn.failed") {
      const error = isPlainObject(event.error) ? event.error : {};
      this.final = { error };
      return ["finished: turn failed -> " + short(typeof error.message === "string" ? error.message : "")];
    }
    if (kind !== "item.completed" && kind !== "item.started") return [];
    const item = isPlainObject(event.item) ? event.item : {};
    const itemKind = item.type;
    if (itemKind === "agent_message") {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      return kind === "item.completed" && text ? ["says: " + short(text)] : [];
    }
    if (itemKind === "command_execution") {
      if (kind === "item.started") return []; // log once, on completion, like agy's ACTIVE-state skip
      let text = `tool: shell ${short(item.command ?? "")}`;
      const exitCode = item.exit_code;
      if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
        text += "  -> exit " + String(exitCode) + ": " + short(item.aggregated_output ?? "");
      }
      return [text];
    }
    if (itemKind === "error" && kind === "item.completed") {
      return ["warning: " + short(item.message ?? "")];
    }
    return [];
  }
}

/** Classify one of Stream.feed()'s readable log-line strings into an
 * events.jsonl event type, without re-parsing each CLI's raw output a
 * second time -- feed() already normalized every CLI's tool/message/error
 * lines into a few fixed textual prefixes, so matching on those prefixes
 * gives a structured event with the same content as the .log line,
 * cheaply, for all four CLIs at once. Ported field-for-field from
 * crewbench_dispatch.py's classify_log_entry(). */
export function classifyLogEntry(entry: string): NormalizedEventType {
  if (entry.startsWith("  error:")) return "run.tool_error";
  if (entry.startsWith("tool: ")) return entry.includes(" -> ") ? "run.tool_error" : "run.tool_call";
  return "run.message";
}
