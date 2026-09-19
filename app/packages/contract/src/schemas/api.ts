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

/** Per-role usage aggregated across every run this task has recorded --
 * summed from each `runs/<role>-r<round>.result.json` envelope's own
 * `usage` (Phase 2 milestone 4). A `null` component (e.g. `cost_usd` for
 * a CLI that doesn't report cost, per this repo's existing convention)
 * makes the whole rollup `null` for that field rather than silently
 * treating it as 0, matching the phase prompt's own "Unknown values are
 * shown as '—', never as 0" requirement for the eventual Usage page. */
export const ApiRoleUsageSchema = z
  .object({
    runs: z.number().int(),
    duration_s: z.union([z.number(), z.null()]),
    input_tokens: z.union([z.number(), z.null()]),
    output_tokens: z.union([z.number(), z.null()]),
    total_tokens: z.union([z.number(), z.null()]),
    cost_usd: z.union([z.number(), z.null()]),
    cli: z.string().nullable(),
    model: z.string().nullable(),
  })
  .strict();
export type ApiRoleUsage = z.infer<typeof ApiRoleUsageSchema>;

/** The task-detail response (`GET /api/tasks/:tid`, Phase 2 milestone 4).
 * `rounds` and `issues` intentionally stay as loosely-typed pass-throughs
 * of `packages/engine`'s own `RoundRecord[]`/`RegisteredIssue[]` shapes
 * (real data, just not re-declared as their own strict zod schemas yet)
 * -- milestone 5 is where the issues/failures tables actually need
 * field-level guarantees on this data, so tightening it is scoped there
 * rather than guessed at here. */
export const ApiTaskDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    phase: TaskPhaseSchema,
    round: z.number().int(),
    branch: z.string().nullable(),
    worktree: z.string().nullable(),
    base_commit: z.string().nullable(),
    jira_key: z.string().nullable(),
    notes: z.array(z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
    stuck_reason: z.string().nullable(),
    lineup: z.record(z.string(), z.unknown()),
    rounds: z.array(z.unknown()),
    issues: z.array(z.unknown()),
    usage: z.record(z.string(), ApiRoleUsageSchema),
    spec: z.unknown().nullable(),
  })
  .catchall(z.unknown());
export type ApiTaskDetail = z.infer<typeof ApiTaskDetailSchema>;

export const ApiRunLogSchema = z
  .object({
    text: z.string(),
    /** Byte offset the caller should pass as `?from=` on its next poll to
     * get only what's new -- matches the incremental-read contract
     * `packages/daemon`'s own event tailer already uses internally. */
    next_offset: z.number().int(),
  })
  .strict();
export type ApiRunLog = z.infer<typeof ApiRunLogSchema>;

export const ApiErrorSchema = z
  .object({
    error: z.string(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;
