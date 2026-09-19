import { z } from "zod";

/** No JSON Schema file on the Python side -- team.json is user-owned/edited
 * directly, loosely structured. Ported from config/defaults.json's shape
 * and lib/dispatch.md §1 ("Build the lineup", "Loop settings", "Workspace
 * settings", "Lineup-confirmation setting"), not from a schema file. */
export const CliNameSchema = z.enum(["host", "claude", "codex", "agy", "copilot"]);
export type CliName = z.infer<typeof CliNameSchema>;

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const PermissionsSchema = z.enum(["safe", "skip"]);
export type Permissions = z.infer<typeof PermissionsSchema>;

/** `model` is a tier ("cheap"/"strong", resolved per-CLI through `tiers`)
 * or an exact model name/alias, passed through unchanged -- kept as a bare
 * string rather than an enum-or-string union, matching the plugin's own
 * "merge, later wins, exact name passes through" rule (lib/dispatch.md §1). */
export const RoleLineupSchema = z
  .object({
    cli: CliNameSchema,
    model: z.string(),
    effort: EffortSchema,
    permissions: PermissionsSchema,
  })
  .partial();
export type RoleLineup = z.infer<typeof RoleLineupSchema>;

export const ROLE_KEYS = ["developer", "tester", "code-reviewer", "ui-ux"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const TiersSchema = z
  .object({
    cheap: z.string(),
    strong: z.string(),
  })
  .partial();
export type Tiers = z.infer<typeof TiersSchema>;

export const LoopSettingsSchema = z
  .object({
    max_rounds: z.number().int().positive(),
    fix_threshold: z.enum(["blocker", "major", "minor"]),
  })
  .partial();
export type LoopSettings = z.infer<typeof LoopSettingsSchema>;

export const WorkspaceSettingsSchema = z
  .object({
    mode: z.enum(["worktree", "in-place"]),
    setup: z.array(z.string()),
    copy: z.array(z.string()),
  })
  .partial();
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export const ConfirmLineupSchema = z.enum(["always", "when_unsaved", "never"]);
export type ConfirmLineup = z.infer<typeof ConfirmLineupSchema>;

export const TeamSchema = z
  .object({
    roles: z.partialRecord(z.enum(ROLE_KEYS), RoleLineupSchema),
    tiers: z.partialRecord(CliNameSchema, TiersSchema),
    loop: LoopSettingsSchema,
    workspace: WorkspaceSettingsSchema,
    confirm_lineup: ConfirmLineupSchema,
  })
  .partial()
  .catchall(z.unknown());
export type Team = z.infer<typeof TeamSchema>;
