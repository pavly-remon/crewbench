import { z } from "zod";
import { extractJson } from "@crewbench/adapters";
import type { Cli, Effort } from "@crewbench/adapters";
import { TaskSpecSchema, type TaskSpec } from "@crewbench/contract";
import { runChatTurn } from "./chat-runner.js";

/** The initial scoping prompt: instructs the lead CLI to ask clarifying
 * questions if the task is underspecified (mirrors
 * skills/new-task/SKILL.md step 2, "Scope first"), and to answer with
 * *only* a JSON object matching the task-spec schema once it has enough
 * information -- mirrors every role brief's "Report format" convention
 * (build-command.ts's buildPrompt()), applied here to the lead's own
 * scoping turn since there is no role brief file for "scoping" itself.
 * No Python precedent exists for this prompt (see
 * docs/app/phase-1-plan.md's milestone 5 note) -- it's new this phase. */
export function buildScopingPrompt(taskText: string, jiraKey?: string | null): string {
  const schema = z.toJSONSchema(TaskSpecSchema);
  return [
    "You are scoping a coding task before it's handed to a development team. " +
      "Ask clarifying questions if the task below is underspecified (missing " +
      "acceptance criteria, unclear affected areas, ambiguous edge cases) -- ask " +
      "in plain language, one message, and wait for an answer.",
    jiraKey ? `Jira key: ${jiraKey}` : null,
    `Task: ${taskText}`,
    "Once you have enough information, respond with *only* a single JSON object " +
      "(no other text before or after it) matching this exact JSON Schema:\n\n" +
      JSON.stringify(schema, null, 2) +
      "\n\nDo not include the JSON object in the same message as a clarifying " +
      "question -- only send it once scoping is actually complete.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export interface ScopingTurnResult {
  sessionId: string | null;
  reply: string;
  /** Set once the reply is a complete, schema-valid task-spec -- null
   * while the conversation is still in clarifying-question territory.
   * The caller (the terminal CLI, per this milestone's scope) drives the
   * back-and-forth: keep calling continueScoping() with the user's answer
   * until this is non-null. */
  spec: TaskSpec | null;
  ok: boolean;
  error: string | null;
}

async function scopingTurn(
  cli: Cli,
  model: string,
  effort: Effort,
  message: string,
  sessionId: string | null,
  cwd: string,
  onChunk?: (text: string) => void,
): Promise<ScopingTurnResult> {
  const result = await runChatTurn(cli, model, effort, message, sessionId, cwd, 120, onChunk);
  if (!result.ok || result.reply === null) {
    return { sessionId: result.sessionId, reply: "", spec: null, ok: false, error: result.error };
  }
  const spec = tryParseTaskSpec(result.reply);
  return { sessionId: result.sessionId, reply: result.reply, spec, ok: true, error: null };
}

export function startScoping(
  cli: Cli,
  model: string,
  effort: Effort,
  taskText: string,
  cwd: string,
  jiraKey?: string | null,
  onChunk?: (text: string) => void,
): Promise<ScopingTurnResult> {
  return scopingTurn(cli, model, effort, buildScopingPrompt(taskText, jiraKey), null, cwd, onChunk);
}

export function continueScoping(
  cli: Cli,
  model: string,
  effort: Effort,
  userAnswer: string,
  sessionId: string,
  cwd: string,
  onChunk?: (text: string) => void,
): Promise<ScopingTurnResult> {
  return scopingTurn(cli, model, effort, userAnswer, sessionId, cwd, onChunk);
}

/** Parses a reply as a task-spec, the same way a role dispatch's result
 * parsing does (extractJson, then schema validation) -- returns null (not
 * a thrown error) for a reply that isn't one, since "this reply is a
 * clarifying question, not a finished spec" is the expected, common case
 * mid-conversation, not a failure. */
export function tryParseTaskSpec(reply: string): TaskSpec | null {
  const candidate = extractJson(reply);
  if (!candidate) return null;
  const parsed = TaskSpecSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
