import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RoleName } from "@crewbench/contract";
import type { Cli, Effort, Permissions } from "@crewbench/adapters";

export interface ResolvedRoleLineup {
  cli: Cli;
  model: string;
  effort: Effort;
  permissions: Permissions;
}

export interface ResolvedLoop {
  maxRounds: number;
  fixThreshold: "blocker" | "major" | "minor";
}

export interface ResolvedWorkspace {
  mode: "worktree" | "in-place";
  setup: string[];
  copy: string[];
}

export interface ResolvedLineup {
  roles: Record<RoleName, ResolvedRoleLineup>;
  loop: ResolvedLoop;
  workspace: ResolvedWorkspace;
  confirmLineup: "always" | "when_unsaved" | "never";
}

/** The on-disk shape of config/defaults.json and .crewbench/team.json --
 * snake_case field names (`max_rounds`, `fix_threshold`), matching the
 * real files (confirmed against config/defaults.json), not this module's
 * own camelCase `Resolved*` types. Keeping these separate rather than
 * reusing `Partial<ResolvedLoop>` etc. is what caught a real bug: an
 * earlier version of this file declared `loop?: Partial<ResolvedLoop>`
 * (camelCase `maxRounds`), so a real `{"loop": {"max_rounds": 5}}` file
 * silently never matched and the hardcoded default (3) won every time. */
interface RawTeamShape {
  roles?: Partial<Record<RoleName, { cli?: Cli | "host"; model?: string; effort?: Effort; permissions?: Permissions }>>;
  tiers?: Partial<Record<Cli, { cheap?: string; strong?: string }>>;
  loop?: { max_rounds?: number; fix_threshold?: ResolvedLoop["fixThreshold"] };
  workspace?: { mode?: ResolvedWorkspace["mode"]; setup?: string[]; copy?: string[] };
  confirm_lineup?: ResolvedLineup["confirmLineup"];
}

async function readJsonIfExists(path: string): Promise<unknown> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Merge, later wins: config/defaults.json -> .crewbench/team.json ->
 * per-task overrides (CLI flags) -- ported field-for-field from
 * lib/dispatch.md §1's "Build the lineup" / "Loop settings" / "Workspace
 * settings" / "Lineup-confirmation setting". `host` resolves to
 * `resolveHostCli` (this CLI has no "the process I'm running inside"
 * question the way the plugin's Team Lead does -- see
 * docs/app/phase-1-plan.md's open question 2 -- so `host` here means
 * "the lead CLI the user picked for this run", passed in explicitly). */
export async function resolveLineup(
  defaultsPath: string,
  projectRoot: string,
  hostCli: Cli,
  overrides: {
    dev?: { cli: Cli; model?: string } | undefined;
    review?: { cli: Cli; model?: string } | undefined;
    rounds?: number | undefined;
  } = {},
): Promise<ResolvedLineup> {
  const defaults = ((await readJsonIfExists(defaultsPath)) as RawTeamShape) ?? {};
  const team = ((await readJsonIfExists(join(projectRoot, ".crewbench", "team.json"))) as RawTeamShape) ?? {};

  const roleNames: RoleName[] = ["developer", "tester", "code-reviewer", "ui-ux"];
  const roles = {} as Record<RoleName, ResolvedRoleLineup>;
  for (const role of roleNames) {
    const d = defaults.roles?.[role] ?? {};
    const t = team.roles?.[role] ?? {};
    const cli = resolveCli((t.cli ?? d.cli ?? "host") as Cli | "host", hostCli);
    const tierOrModel = t.model ?? d.model ?? "cheap";
    const model = resolveModel(tierOrModel, cli, defaults, team);
    roles[role] = {
      cli,
      model,
      effort: (t.effort ?? d.effort ?? "medium") as Effort,
      permissions: (t.permissions ?? d.permissions ?? "safe") as Permissions,
    };
  }

  if (overrides.dev) {
    roles.developer = {
      ...roles.developer,
      cli: overrides.dev.cli,
      model: overrides.dev.model ?? roles.developer.model,
    };
  }
  if (overrides.review) {
    roles["code-reviewer"] = {
      ...roles["code-reviewer"],
      cli: overrides.review.cli,
      model: overrides.review.model ?? roles["code-reviewer"].model,
    };
  }

  const loop: ResolvedLoop = {
    maxRounds: overrides.rounds ?? team.loop?.max_rounds ?? defaults.loop?.max_rounds ?? 3,
    fixThreshold: team.loop?.fix_threshold ?? defaults.loop?.fix_threshold ?? "major",
  };
  const workspace: ResolvedWorkspace = {
    mode: team.workspace?.mode ?? defaults.workspace?.mode ?? "worktree",
    setup: team.workspace?.setup ?? defaults.workspace?.setup ?? [],
    copy: team.workspace?.copy ?? defaults.workspace?.copy ?? [".env", ".env.local"],
  };
  const confirmLineup = team.confirm_lineup ?? defaults.confirm_lineup ?? "when_unsaved";

  return { roles, loop, workspace, confirmLineup };
}

function resolveCli(value: Cli | "host", hostCli: Cli): Cli {
  return value === "host" ? hostCli : value;
}

function resolveModel(tierOrModel: string, cli: Cli, defaults: RawTeamShape, team: RawTeamShape): string {
  if (tierOrModel !== "cheap" && tierOrModel !== "strong") return tierOrModel; // an exact model name/alias passes through unchanged
  const tiers = team.tiers?.[cli] ?? defaults.tiers?.[cli];
  return tiers?.[tierOrModel] ?? tierOrModel;
}
