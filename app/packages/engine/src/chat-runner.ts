import { spawn } from "node:child_process";
import type { Cli, Effort } from "@crewbench/adapters";
import { buildChatCommand, cliArgvPrefix, extractChatReply, resolveCliPath, Stream } from "@crewbench/adapters";
import { terminateProcessGroup, hardKillProcessGroup, GRACEFUL_KILL_TIMEOUT_S } from "./process-kill.js";

export interface ChatTurnResult {
  reply: string | null;
  sessionId: string | null;
  ok: boolean;
  error: string | null;
}

/** Runs one turn of a plain conversation with `cli` -- used for scoping
 * (scoping.ts) and the final-summary LLM call (summary.ts's
 * `LlmSummarizer`, wired up by a caller). Spawns the real CLI process the
 * same way runner.ts's dispatchRole() does (detached process group,
 * timeout with group-kill), but without any of the role-dispatch
 * machinery (no schema, no prompt/hand-off assembly, no events.jsonl --
 * a scoping conversation isn't a "run" in the contract's sense until it
 * produces a task-spec). */
export async function runChatTurn(
  cli: Cli,
  model: string,
  effort: Effort,
  message: string,
  sessionId: string | null,
  cwd: string,
  timeoutS = 120,
  /** Phase 3 milestone 3, Design decision 4: called with each readable
   * log line `stream.feed()` produces as output arrives (the same lines
   * dispatchRole()'s own logging would write, e.g. "says: ...", "tool:
   * ..."), not a token-level diff of the final reply -- the smallest real
   * addition that lets a caller (the daemon's scoping SSE route) forward
   * genuine incremental progress without a second output parser. The
   * final `reply` returned once the process exits is still extracted the
   * same way as before (`extractChatReply`), unaffected by this. */
  onChunk?: (text: string) => void,
): Promise<ChatTurnResult> {
  const cliPath = resolveCliPath(cli);
  if (!cliPath) {
    return { reply: null, sessionId, ok: false, error: `${cli} is not installed or not on PATH` };
  }
  const { argv: builtArgv, stdin } = buildChatCommand(cli, model, effort, message, sessionId);
  const argv = [...cliArgvPrefix(cliPath), ...builtArgv.slice(1)];

  const stream = new Stream(cli);
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: [stdin !== null ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (stdin !== null && child.stdin) {
    child.stdin.write(stdin);
    child.stdin.end();
  }

  let stdoutAll = "";
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stdoutAll += text;
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const readable = stream.feed(line + "\n");
      if (onChunk) for (const l of readable) onChunk(l);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stdoutAll += chunk.toString("utf-8");
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      if (child.pid) {
        terminateProcessGroup(child.pid);
        const hardTimer = setTimeout(() => {
          if (child.pid) hardKillProcessGroup(child.pid);
        }, GRACEFUL_KILL_TIMEOUT_S * 1000);
        child.once("exit", () => clearTimeout(hardTimer));
      }
    }, timeoutS * 1000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (buffer.trim()) {
    const readable = stream.feed(buffer);
    if (onChunk) for (const l of readable) onChunk(l);
  }

  const reply = extractChatReply(cli, stream.final, stdoutAll);
  const newSessionId = stream.sessionId ?? sessionId;
  if (exitCode !== 0) {
    return { reply, sessionId: newSessionId, ok: false, error: `${cli} exited with code ${String(exitCode)}` };
  }
  if (reply === null) {
    return { reply: null, sessionId: newSessionId, ok: false, error: "no reply text found in output" };
  }
  return { reply, sessionId: newSessionId, ok: true, error: null };
}
