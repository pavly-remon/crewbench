import { z } from "zod";
import { SchemaVersionSchema } from "./common.js";

/** Ported field-for-field from schemas/task-state.json. See
 * docs/app/contract/README.md's "tasks/<task-id>/state.json" section. */
export const TASK_PHASES = [
  "scoping",
  "design",
  "implementing",
  "verifying",
  "fixing",
  "awaiting_commit",
  "done",
  "stopped",
  "failed",
] as const;
export const TaskPhaseSchema = z.enum(TASK_PHASES);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const TASK_COMMANDS = ["new-task", "test", "review", "design"] as const;
export const TaskCommandSchema = z.enum(TASK_COMMANDS);
export type TaskCommand = z.infer<typeof TaskCommandSchema>;

export const GateStepSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    exit_code: z.union([z.number().int(), z.null()]),
    duration_s: z.number(),
    timed_out: z.boolean(),
    output_tail: z.string(),
  })
  .strict();
export type GateStep = z.infer<typeof GateStepSchema>;

export const GateResultSchema = z
  .object({
    ok: z.boolean(),
    steps: z.array(GateStepSchema),
  })
  .strict();
export type GateResult = z.infer<typeof GateResultSchema>;

export const TaskRoundSchema = z
  .object({
    round: z.number().int(),
    runs: z.array(z.string()),
    gate: z.union([GateResultSchema, z.null()]).optional(),
    verdicts: z.record(z.string(), z.unknown()).optional(),
    open_issue_ids: z.array(z.string()).optional(),
    snapshot_ref: z.union([z.string(), z.null()]).optional(),
  })
  .catchall(z.unknown());
export type TaskRound = z.infer<typeof TaskRoundSchema>;

export const RoleUsageSchema = z
  .object({
    runs: z.number().int(),
    duration_s: z.union([z.number(), z.null()]),
    tokens: z.union([z.number(), z.null()]),
    cost_usd: z.union([z.number(), z.null()]),
    cli: z.string(),
    model: z.string(),
  })
  .partial()
  .catchall(z.unknown());
export type RoleUsage = z.infer<typeof RoleUsageSchema>;

export const TaskStateSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    /** YYYYMMDD-HHMM-<up to 5 word kebab slug>-<4 hex>. Older ids without
     * the hex suffix (pre Phase-0) are still valid. */
    id: z.string(),
    command: TaskCommandSchema,
    title: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    phase: TaskPhaseSchema,
    round: z.number().int(),
    lineup: z.record(z.string(), z.unknown()),
    base_commit: z.union([z.string(), z.null()]),
    branch: z.union([z.string(), z.null()]),
    /** Absolute path, or null in in-place mode. */
    worktree: z.union([z.string(), z.null()]),
    jira_key: z.union([z.string(), z.null()]).optional(),
    host_override: z.union([z.string(), z.null()]).optional(),
    doctor: z.record(z.string(), z.unknown()).optional(),
    acceptance_criteria: z.array(z.string()),
    design_spec_file: z.union([z.string(), z.null()]),
    /** Phase 1 addition: the engine's scoping output, parallel to
     * design_spec_file -- see docs/app/phase-1-plan.md's open question 3.
     * Never written by the plugin; optional so a plugin-created task's
     * state.json (which has no such field) still validates. */
    spec_file: z.union([z.string(), z.null()]).optional(),
    rounds: z.array(TaskRoundSchema),
    usage: z.record(z.string(), RoleUsageSchema),
    notes: z.array(z.string()),
  })
  .catchall(z.unknown()); // additionalProperties: true, matching schemas/task-state.json
export type TaskState = z.infer<typeof TaskStateSchema>;

export const IndexEntrySchema = z
  .object({
    schema_version: SchemaVersionSchema,
    id: z.string(),
    command: z.union([TaskCommandSchema, z.null()]).optional(),
    title: z.union([z.string(), z.null()]).optional(),
    phase: z.union([TaskPhaseSchema, z.null()]).optional(),
    round: z.union([z.number().int(), z.null()]).optional(),
    updated_at: z.union([z.string(), z.null()]).optional(),
  })
  .catchall(z.unknown());
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

/** .crewbench/index.json: { "<task-id>": IndexEntry } */
export const TaskIndexSchema = z.record(z.string(), IndexEntrySchema);
export type TaskIndex = z.infer<typeof TaskIndexSchema>;
