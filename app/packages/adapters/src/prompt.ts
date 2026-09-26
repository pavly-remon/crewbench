import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleName } from "@crewbench/contract";
import type { Cli } from "./types.js";
import { ROLE_BRIEF_FILES } from "./types.js";
import { limitsFor } from "./limits.js";

/** Ported field-for-field from crewbench_dispatch.py's strip_frontmatter(). */
export function stripFrontmatter(text: string): string {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      return text.slice(end + 4).replace(/^\n+/, "");
    }
  }
  return text;
}

/** Ported field-for-field from crewbench_dispatch.py's build_prompt().
 * `agentsDir` is `<crewbench-root>/agents` -- the caller resolves the
 * plugin root (this package has no built-in notion of "the repo root",
 * unlike the Python script which can derive it from its own file path). */
export function buildPrompt(
  agentsDir: string,
  role: RoleName,
  cli: Cli,
  handoff: string,
  schema: unknown,
  skip = false,
): string {
  const briefPath = join(agentsDir, ROLE_BRIEF_FILES[role]);
  const brief = stripFrontmatter(readFileSync(briefPath, "utf-8"));
  return [
    brief.trim(),
    "## Limits\n\n" + limitsFor(role, cli, skip),
    "## Hand-off from the Team Lead\n\n" + handoff.trim(),
    "## Running non-interactively\n\n" +
      "You are running non-interactively as part of a crewbench team. Don't ask " +
      "questions; put ambiguities in your result. If an action you need is denied " +
      'or blocked by the sandbox, don\'t try to work around it — list it under "blocked" ' +
      'and continue with what you can do. Your brief\'s "Report format" section above ' +
      "already told you to end with a single JSON object and nothing else — here is the " +
      "exact JSON Schema it must match:\n\n" +
      JSON.stringify(schema, null, 2),
  ].join("\n\n");
}

/** Short text for CLIs whose -p/--prompt takes the prompt as an argv value
 * (no documented stdin mode: agy and Copilot) instead of the full prompt,
 * to avoid E2BIG on large hand-offs. Ported from
 * crewbench_dispatch.py's _prompt_pointer(). */
export function promptPointer(promptFile: string): string {
  return (
    "Your complete instructions for this task are in the file at this exact absolute " +
    `path: ${promptFile}\n\nRead the whole file and follow it exactly — it contains your ` +
    "role brief, your limits for this run, the Team Lead's hand-off, and how to report your " +
    "final answer. Treat it as if it were written here directly; this message is only a " +
    "pointer to it."
  );
}
