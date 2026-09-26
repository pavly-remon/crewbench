import type { Cli, Effort } from "./types.js";

const NO_EFFORT = new Set(["", "none", "n/a"]);

/** Builds a plain conversational turn -- no role brief, no result schema,
 * no tool/permission restrictions, since this is the "lead" CLI's own
 * scoping conversation or summary call (docs/app/phase-1-plan.md's
 * milestone 5), not a scoped crew-role dispatch. There is no Python
 * precedent to port this from -- the plugin's Team Lead does this as its
 * own LLM turn, with no separate headless call. `VERIFY`: these flags
 * follow each CLI's already-confirmed role-dispatch conventions
 * (build-command.ts) as closely as a plain chat turn allows, but the
 * exact flag set for a *non-role* conversational call was not separately
 * re-verified against each CLI's live `--help` output. */
export function buildChatCommand(
  cli: Cli,
  model: string,
  effort: Effort,
  message: string,
  sessionId: string | null,
): { argv: string[]; stdin: string | null } {
  const hasEffort = !NO_EFFORT.has(effort.toLowerCase());
  switch (cli) {
    case "claude": {
      const cmd = ["claude", "-p", "--model", model, "--output-format", "stream-json", "--verbose"];
      if (sessionId) cmd.push("--resume", sessionId);
      if (hasEffort) cmd.push("--effort", effort);
      return { argv: cmd, stdin: message };
    }
    case "codex": {
      const cmd = sessionId ? ["codex", "exec", "resume", sessionId, "-m", model, "--json"] : ["codex", "exec", "-m", model, "--json"];
      if (hasEffort) cmd.push("-c", `model_reasoning_effort=${effort}`);
      cmd.push("-");
      return { argv: cmd, stdin: message };
    }
    case "agy": {
      const cmd = ["agy", "--model", model, "--output-format", "stream-json"];
      if (sessionId) cmd.push("--conversation", sessionId);
      if (hasEffort) cmd.push("--effort", effort);
      cmd.push(`-p=${message}`);
      return { argv: cmd, stdin: null };
    }
    case "copilot": {
      const cmd = ["copilot", "-s", "--no-ask-user", "--model", model];
      if (sessionId) cmd.push(`--resume=${sessionId}`);
      if (hasEffort) cmd.push("--effort", effort);
      cmd.push("-p", message);
      return { argv: cmd, stdin: null };
    }
  }
}

/** Plain-text reply extraction for a chat turn -- unlike a role dispatch,
 * there's no JSON result schema to validate against; the reply is
 * whatever text the CLI's final message contains. Reuses the same
 * Stream-shaped `final` object claude/agy/codex's Stream parsers already
 * populate. */
export function extractChatReply(cli: Cli, final: Record<string, unknown> | null, stdout: string): string | null {
  if (!final) return extractPlainText(cli, stdout);
  if (cli === "claude") {
    const text = final.result ?? final.response;
    return typeof text === "string" ? text : extractPlainText(cli, stdout);
  }
  if (cli === "codex") {
    // No single "final text" field in the turn.completed event -- codex's
    // Stream stores only usage/error there (see stream.ts's codex()
    // branch); the reply text comes from the agent_message items already
    // written to the log, which this function doesn't have direct access
    // to. Callers should prefer the last "says:" line the Stream produced,
    // falling back to a raw stdout scan.
    return extractPlainText(cli, stdout);
  }
  if (cli === "agy") {
    const text = final.response ?? final.result;
    return typeof text === "string" ? text : extractPlainText(cli, stdout);
  }
  return extractPlainText(cli, stdout);
}

function extractPlainText(cli: Cli, stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  if (cli === "claude" || cli === "agy" || cli === "codex") {
    // stream-json/--json output: take the last non-empty line's best-effort
    // text content rather than the raw JSONL.
    const lines = trimmed.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i] as string) as Record<string, unknown>;
        const text = firstStringField(event, ["text", "result", "response", "message"]);
        if (text) return text;
      } catch {
        continue;
      }
    }
    return null;
  }
  return trimmed; // copilot's plain -s output is already just text
}

function firstStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}
