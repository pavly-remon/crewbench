import type { Cli } from "./types.js";

/** Ported from crewbench_dispatch.py's HOST_ENV_PREFIXES: env var name
 * prefixes each host CLI is confirmed (claude) or believed (codex/agy/
 * copilot -- VERIFY, inferred from each CLI's own documented env-var
 * prefixes, not from a live nested session) to set, so a child launched on
 * a *different* CLI doesn't inherit host-identity markers that could
 * change its behavior. Never touches CREWBENCH_* -- those are what
 * childEnv() itself sets for the child. */
export const HOST_ENV_PREFIXES: Record<Cli, readonly string[]> = {
  claude: ["CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_PLUGIN_ROOT", "CLAUDE_EFFORT", "AI_AGENT"],
  codex: ["CODEX_"],
  agy: ["ANTIGRAVITY_", "GEMINI_CLI"],
  copilot: ["COPILOT_"],
};

/** Environment for the launched child CLI process: strips other hosts'
 * identity markers and sets the recursion guard the child's own crewbench
 * (if it has crewbench installed too) checks. Ported field-for-field from
 * crewbench_dispatch.py's child_env(). */
export function childEnv(cli: Cli, role: string, taskId: string | null): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [host, prefixes] of Object.entries(HOST_ENV_PREFIXES) as [Cli, readonly string[]][]) {
    if (host === cli) continue;
    for (const key of Object.keys(env)) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        delete env[key];
      }
    }
  }
  env.CREWBENCH_ROLE = role;
  env.CREWBENCH_TASK = taskId ?? "";
  return env;
}
