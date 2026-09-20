import type { ApiCli, ApiEffort, Team } from "@crewbench/contract";
import { ROLE_KEYS, type RoleKey } from "@crewbench/contract";

export interface LineupRoleValue {
  cli: ApiCli;
  model: string;
  effort: ApiEffort;
  permissions: "safe" | "skip";
}

const REAL_CLIS: ApiCli[] = ["claude", "codex", "agy", "copilot"];

/** Resolves a tier ("cheap"/"strong") or exact model name/alias against
 * `team.json`'s own `tiers[cli]` mapping, exactly the same "some, not
 * all, of these keys, exact name passes through" rule
 * `packages/cli/src/lineup.ts`'s `resolveModel()` already implements for
 * `crewbench run` -- reimplemented here, not imported, since the daemon
 * deliberately has no tier-resolution endpoint of its own (see
 * `routes/lineup.ts`'s docstring: the app never reads `config/
 * defaults.json`, only `team.json`, the same real gap Phase 3 milestone
 * 3's own log already disclosed for the scoping-chat CLI/model picker).
 * Falls back to the tier string itself when unresolvable, matching
 * `resolveModel()`'s own real fallback -- not a new failure mode this
 * introduces. */
export function resolveModelTier(tierOrModel: string, cli: ApiCli, team: Team | undefined): string {
  if (tierOrModel !== "cheap" && tierOrModel !== "strong") return tierOrModel;
  const tiers = team?.tiers?.[cli];
  return tiers?.[tierOrModel] ?? tierOrModel;
}

/** A starting per-role lineup suggestion from `team.json` alone, for the
 * lineup step to pre-fill before the user edits anything.
 * `team.json`'s own `roles[role].cli` can be `"host"` (a plugin/CLI-flag
 * concept meaning "whichever CLI is driving this run") -- the app has no
 * such concept (Phase 3 milestone 3's own log flagged this same real
 * gap), so `"host"` falls back to `"claude"` here, matching
 * `packages/cli/src/commands/team.ts`'s own real default
 * (`hostCli = ... ?? "claude"`) when nothing else names a host. */
export function suggestLineup(team: Team | undefined): Record<RoleKey, LineupRoleValue> {
  const roles = {} as Record<RoleKey, LineupRoleValue>;
  for (const role of ROLE_KEYS) {
    const r = team?.roles?.[role];
    const cli = (r?.cli && r.cli !== "host" ? r.cli : "claude") as ApiCli;
    const tierOrModel = r?.model ?? "cheap";
    roles[role] = {
      cli: REAL_CLIS.includes(cli) ? cli : "claude",
      model: resolveModelTier(tierOrModel, cli, team),
      effort: (r?.effort ?? "medium") as ApiEffort,
      permissions: (r?.permissions ?? "safe") as "safe" | "skip",
    };
  }
  return roles;
}
