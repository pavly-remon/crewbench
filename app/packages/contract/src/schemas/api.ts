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

/** Mirrors `packages/engine`'s `types.ts` field-for-field (the engine's
 * own internal shapes, not a second reinterpretation) -- tightened here
 * in Phase 2 milestone 5 for the issues/failures tables, which need
 * real field-level guarantees on this data rather than the loosely-typed
 * pass-through milestone 4 shipped with. */
export const ApiTestFailureSchema = z
  .object({
    test: z.string(),
    file: z.string(),
    expected: z.string(),
    actual: z.string(),
    reason: z.string(),
  })
  .strict();

export const ApiGateStepSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    exit_code: z.union([z.number().int(), z.null()]),
    duration_s: z.number(),
    timed_out: z.boolean(),
    output_tail: z.string(),
  })
  .strict();

export const ApiGateResultSchema = z
  .object({
    ok: z.boolean(),
    steps: z.array(ApiGateStepSchema),
  })
  .strict();

export const ApiTesterResultSchema = z
  .object({
    verdict: z.enum(["pass", "fail", "error"]),
    failures: z.array(ApiTestFailureSchema),
    screenshots: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());

export const ApiRawIssueSchema = z
  .object({
    file: z.string(),
    line: z.union([z.number().int(), z.null()]),
    severity: z.enum(["blocker", "major", "minor"]),
    category: z.string(),
    change: z.string(),
  })
  .catchall(z.unknown());

export const ApiReviewerResultSchema = z
  .object({
    verdict: z.enum(["approve", "changes_requested"]),
    issues: z.array(ApiRawIssueSchema),
    previous_issues: z
      .array(z.object({ id: z.string(), status: z.enum(["resolved", "still_present"]), note: z.string() }).strict())
      .optional(),
  })
  .catchall(z.unknown());

export type ApiTestFailure = z.infer<typeof ApiTestFailureSchema>;
export type ApiGateResult = z.infer<typeof ApiGateResultSchema>;
export type ApiTesterResult = z.infer<typeof ApiTesterResultSchema>;
export type ApiRawIssue = z.infer<typeof ApiRawIssueSchema>;
export type ApiReviewerResult = z.infer<typeof ApiReviewerResultSchema>;

export const ApiRoundRecordSchema = z
  .object({
    round: z.number().int(),
    gate: z.union([ApiGateResultSchema, z.null()]),
    tester: z.union([ApiTesterResultSchema, z.null()]),
    reviewer: z.union([ApiReviewerResultSchema, z.null()]),
    fixList: z.union([z.array(z.unknown()), z.null()]),
  })
  .strict();
export type ApiRoundRecord = z.infer<typeof ApiRoundRecordSchema>;

export const ApiRegisteredIssueSchema = z
  .object({
    id: z.string(),
    firstSeenRound: z.number().int(),
    file: z.string(),
    category: z.string(),
    severity: z.enum(["blocker", "major", "minor"]),
    change: z.string(),
    status: z.enum(["open", "resolved", "still_present"]),
    consecutiveStillPresent: z.number().int(),
  })
  .strict();
export type ApiRegisteredIssue = z.infer<typeof ApiRegisteredIssueSchema>;

/** The task-detail response (`GET /api/tasks/:tid`, milestones 4-5).
 * `warnings` (milestone 5) is every `git.warning` event recorded for this
 * task, read straight from `events.jsonl` -- the same events
 * `packages/engine`'s real git-safety-snapshot comparison
 * (`gitChanges()`, wired into `dispatchRole()`) already emits; this is
 * the first place anything actually surfaces them to a person. */
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
    rounds: z.array(ApiRoundRecordSchema),
    issues: z.array(ApiRegisteredIssueSchema),
    usage: z.record(z.string(), ApiRoleUsageSchema),
    spec: z.unknown().nullable(),
    warnings: z.array(z.string()),
  })
  .catchall(z.unknown());
export type ApiTaskDetail = z.infer<typeof ApiTaskDetailSchema>;

/** `GET /api/tasks/:tid/diff?round=base|N` (milestone 5). **Real,
 * disclosed limitation**: nothing in this codebase snapshots git state
 * per round (the developer's changes across rounds stay as one
 * cumulative uncommitted working-tree diff until the final
 * commit-approval step -- confirmed by reading `packages/engine`'s git
 * module, not assumed), so a round-scoped delta isn't actually
 * derivable from git history today. `round=N` and `round=base` both
 * return the same "everything changed since `base_commit`" diff;
 * `mode` tells the UI which was asked for, so it can label the result
 * honestly instead of implying a round-isolated diff exists. */
export const ApiDiffSchema = z
  .object({
    mode: z.enum(["base", "round"]),
    round: z.union([z.number().int(), z.null()]),
    diff: z.string(),
  })
  .strict();
export type ApiDiff = z.infer<typeof ApiDiffSchema>;

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

/** `GET /api/doctor` (milestone 6) -- mirrors `packages/adapters`'
 * `DoctorReport` field-for-field, one per CLI. Cached server-side with a
 * short TTL (`routes/doctor.ts`) since `doctor()` makes real network/auth
 * calls per adapter -- this schema doesn't know or care about that, it
 * just describes the response shape either way. */
export const ApiDoctorReportSchema = z
  .object({
    cli: z.enum(["claude", "codex", "agy", "copilot"]),
    installed: z.boolean(),
    version: z.string().nullable(),
    config_dir: z.string().nullable(),
    config_dir_writable: z.boolean().nullable(),
    network_ok: z.boolean().nullable(),
    network_detail: z.string().nullable(),
    logged_in: z.boolean().nullable(),
    auth_detail: z.string().nullable(),
    ok: z.boolean(),
    errors: z.array(z.string()),
  })
  .strict();
export type ApiDoctorReport = z.infer<typeof ApiDoctorReportSchema>;

export const ApiDoctorResponseSchema = z
  .object({
    reports: z.array(ApiDoctorReportSchema),
    /** When this result was produced -- lets the UI show "checked 3m
     * ago" and offer a manual refresh, per the phase prompt's own
     * "(cached)" note on this endpoint. */
    checked_at: z.string(),
  })
  .strict();
export type ApiDoctorResponse = z.infer<typeof ApiDoctorResponseSchema>;

/** `GET /api/projects/:pid/usage` (milestone 6) -- one row per task,
 * reusing the same per-role usage rollup `GET /api/tasks/:tid` already
 * computes (`task-detail.ts`'s `aggregateUsage()`), so there is one
 * source of truth for "how is usage computed," not a second one for a
 * project-wide view. */
export const ApiProjectUsageRowSchema = z
  .object({
    task_id: z.string(),
    title: z.string(),
    usage: z.record(z.string(), ApiRoleUsageSchema),
  })
  .strict();
export type ApiProjectUsageRow = z.infer<typeof ApiProjectUsageRowSchema>;

export const ApiErrorSchema = z
  .object({
    error: z.string(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;
