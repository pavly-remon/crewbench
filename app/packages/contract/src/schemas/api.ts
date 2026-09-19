import { z } from "zod";
import { TaskCommandSchema, TaskPhaseSchema } from "./task-state.js";

/** Daemon API response envelopes (Phase 2). These describe what the
 * daemon serves over HTTP, not an on-disk file -- there is no Python-side
 * equivalent to port from. Every daemon route response is validated
 * against one of these before being sent (docs/app/phase-2-plan.md's
 * milestone 1 design decision), so a daemon bug producing a
 * schema-invalid response fails loudly server-side instead of reaching a
 * client silently wrong. */

export const ApiProjectSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    name: z.string(),
    added_at: z.string(),
    active_task_count: z.number().int(),
    recent_task_count: z.number().int(),
  })
  .strict();
export type ApiProject = z.infer<typeof ApiProjectSchema>;

export const ApiProjectListSchema = z.array(ApiProjectSchema);

/** Mirrors `packages/engine`'s `TaskIndexRow` (read from
 * `.crewbench/index.json`) -- fields are optional because a legacy
 * (schema_version 0, plugin-written) index entry may be missing some of
 * them (docs/app/contract/README.md's "Legacy tasks" note), and the
 * daemon must serve those gracefully rather than fail validation.
 * `.catchall` (not `.strict()`) for the same reason: a legacy or
 * future-plugin-version index entry may carry extra fields this schema
 * doesn't know about yet, and the daemon shouldn't 500 just because it's
 * unfamiliar with one. */
export const ApiTaskSummarySchema = z
  .object({
    id: z.string(),
    command: TaskCommandSchema.optional(),
    title: z.string().optional(),
    phase: TaskPhaseSchema.optional(),
    round: z.number().int().optional(),
    updated_at: z.string().optional(),
  })
  .catchall(z.unknown());
export type ApiTaskSummary = z.infer<typeof ApiTaskSummarySchema>;

export const ApiTaskListSchema = z.array(ApiTaskSummarySchema);

export const ApiErrorSchema = z
  .object({
    error: z.string(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;
