import { join } from "node:path";
import type { LoopSettings } from "@crewbench/engine";
import { readJsonOrDefault } from "@crewbench/engine";

/** Approximates the loop settings a task's rounds actually ran under, for
 * `rehydrateState()` (Phase 2 milestone 4's task-detail read). This is a
 * real, disclosed limitation, not a full reconstruction: `state.json`
 * never records what `loop.max_rounds`/`fix_threshold` were *at the time*
 * a given round ran (packages/cli's `resolveLineup()` resolves them
 * fresh every invocation and nothing persists the result), so a project's
 * `team.json` having changed since is invisible to this reader. Reads
 * only `.crewbench/team.json` -- deliberately skips
 * `config/defaults.json`, which lives in the crewbench *plugin* root
 * (`packages/cli`'s `findRoot()`), a concept this daemon has no reason to
 * depend on for a read-only display value. Falls back to the same
 * hardcoded defaults `packages/engine`'s own `initialState()` and
 * `packages/cli`'s `resolveLineup()` already use (`max_rounds: 3,
 * fix_threshold: "major"`), so an absent/unreadable `team.json` degrades
 * to the same answer the real run most likely used. */
export async function resolveLoopSettings(projectPath: string): Promise<LoopSettings> {
  const team = await readJsonOrDefault<{ loop?: { max_rounds?: number; fix_threshold?: LoopSettings["fixThreshold"] } }>(
    join(projectPath, ".crewbench", "team.json"),
    {},
  );
  return {
    maxRounds: team.loop?.max_rounds ?? 3,
    fixThreshold: team.loop?.fix_threshold ?? "major",
  };
}
