import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexStrictSchema } from "@crewbench/contract";
import type { BuildCommandArgs, BuildCommandResult } from "./types.js";
import { READ_ONLY_ROLES } from "./types.js";
import { CLAUDE_TOOLS } from "./limits.js";
import { promptPointer } from "./prompt.js";

const NO_EFFORT = new Set(["", "none", "n/a"]);

/** Ported field-for-field from crewbench_dispatch.py's build_command().
 * `prompt` is the full assembled prompt; `promptFile` is where it was
 * written to disk. Claude and Codex read the full prompt from stdin (no
 * argv size limit there); agy and Copilot get a short pointer to
 * `promptFile` instead. `tmpDir` is a scratch directory for this run
 * (codex's strict schema copy, its -o last-message file, copilot's
 * --usage-output-file). */
export function buildCommand(
  args: BuildCommandArgs,
  prompt: string,
  promptFile: string,
  schemaPath: string,
  tmpDir: string,
): BuildCommandResult {
  const { role, model, effort } = args;
  const hasEffort = !NO_EFFORT.has(effort.toLowerCase());
  const timeoutS = args.timeoutS;
  // --skip-permissions never applies to the read-only reviewer.
  const skip = args.skipPermissions && !READ_ONLY_ROLES.has(role);

  if (args.cli === "claude") {
    // plan keeps the reviewer read-only; auto has a classifier review each
    // action; bypassPermissions (opt-in) skips permission checks.
    const mode = READ_ONLY_ROLES.has(role) ? "plan" : skip ? "bypassPermissions" : "auto";
    const cmd = [
      "claude",
      "-p",
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      readFileSync(schemaPath, "utf-8"),
      "--tools",
      CLAUDE_TOOLS[role],
      "--strict-mcp-config",
      "--permission-mode",
      mode,
    ];
    if (hasEffort) cmd.push("--effort", effort);
    return { argv: cmd, stdin: prompt, extraOutputFile: null };
  }

  if (args.cli === "agy") {
    // --add-dir makes the project agy's workspace, so reads and edits
    // there don't need a prompt; shell commands still follow the user's
    // allowlist.
    const cmd = [
      "agy",
      "--model",
      model,
      "--sandbox",
      "--add-dir",
      args.cwd,
      "--mode",
      READ_ONLY_ROLES.has(role) ? "plan" : "accept-edits",
      "--output-format",
      "stream-json",
      "--json-schema",
      schemaPath,
      "--print-timeout",
      `${Math.max(1, Math.trunc(timeoutS))}s`,
    ];
    if (skip) cmd.push("--dangerously-skip-permissions");
    if (args.conversation) cmd.push("--conversation", args.conversation);
    if (hasEffort) cmd.push("--effort", effort);
    cmd.push(`-p=${promptPointer(promptFile)}`);
    return { argv: cmd, stdin: null, extraOutputFile: null };
  }

  if (args.cli === "codex") {
    const last = join(tmpDir, "last-message.txt");
    // OpenAI structured-outputs strict mode (confirmed live) rejects our
    // canonical schema files as-is whenever they have an optional
    // top-level property -- codex gets its own transformed copy instead
    // of the canonical file. See codexStrictSchema()'s docstring.
    const strictSchemaPath = join(tmpDir, "output-schema.json");
    const canonicalSchema: unknown = JSON.parse(readFileSync(schemaPath, "utf-8"));
    writeFileSync(strictSchemaPath, JSON.stringify(codexStrictSchema(canonicalSchema as Record<string, unknown>)), "utf-8");
    const cmd = [
      "codex",
      "exec",
      "-m",
      model,
      "-s",
      READ_ONLY_ROLES.has(role) ? "read-only" : skip ? "danger-full-access" : "workspace-write",
      "--output-schema",
      strictSchemaPath,
      "-o",
      last,
      "--json",
    ];
    if (hasEffort) cmd.push("-c", `model_reasoning_effort=${effort}`);
    cmd.push("-");
    return { argv: cmd, stdin: prompt, extraOutputFile: last };
  }

  // copilot. Confirmed live (`copilot --help`, GitHub Copilot CLI 1.0.83):
  // --usage-output-file writes real per-session token counts as JSON once
  // the run finishes -- see usage.ts's copilot branch.
  const usageFile = join(tmpDir, "usage.json");
  const cmd = ["copilot", "-s", "--no-ask-user", "--model", model, "--usage-output-file", usageFile];
  if (skip) {
    cmd.push("--allow-all-tools");
  } else {
    // Copilot has no per-run sandbox flag, so shell stays denied.
    cmd.push("--deny-tool=shell", "--deny-tool=url");
    if (!READ_ONLY_ROLES.has(role)) cmd.push("--allow-tool=write");
  }
  if (hasEffort) cmd.push("--effort", effort);
  cmd.push("-p", promptPointer(promptFile));
  return { argv: cmd, stdin: null, extraOutputFile: usageFile };
}
