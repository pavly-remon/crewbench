import type { ApiCli } from "@crewbench/contract";

/** A hand-maintained, best-effort list of common model names per CLI --
 * NOT a live/verified list (that only genuinely exists for `agy` today,
 * `ModelField`'s own docstring in `role-lineup-editor.tsx` has the full
 * "only agy has a real listing command" story). Every name here is a
 * real one already referenced somewhere else in this codebase, not
 * invented: claude's aliases are confirmed against `claude --help`'s own
 * inline examples (`@crewbench/adapters`' `model-check.ts`); codex's and
 * copilot's tier names are `config/defaults.json`'s own real
 * `tiers.codex`/`tiers.copilot` values, and `o3`/`gpt-5.4` are real
 * examples straight from `codex --help`/`copilot --help`'s own output
 * (checked live against the actual installed binaries on this machine).
 *
 * Last checked: 2026-09-26. This WILL drift as each CLI ships new
 * models -- there is no live source to re-derive it from automatically
 * (that's the entire reason this list exists instead of a real
 * dropdown), so periodic manual review is expected, not optional. */
export const CURATED_MODELS: Partial<Record<ApiCli, string[]>> = {
  claude: ["fable", "opus", "sonnet"],
  codex: ["gpt-5.6-terra", "gpt-5.6-sol", "o3"],
  copilot: ["claude-sonnet-5", "claude-opus-5", "gpt-5.4"],
};
