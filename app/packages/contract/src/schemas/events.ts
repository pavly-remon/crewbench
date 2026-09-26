import { z } from "zod";
import { UsageSchema } from "./envelope.js";
import { GateStepSchema } from "./task-state.js";

/** Ported field-for-field from docs/app/contract/events.md's catalog
 * (Phase 0, milestone 3). `v` is the event LINE's format version (currently
 * 1) -- separate from schema_version, which versions state.json/
 * index.json/status.json/the envelope, not events.jsonl's line shape. */
export const EVENTS_FORMAT_VERSION = 1;

const EventBase = z.object({
  v: z.number().int(),
  ts: z.string(),
  seq: z.number().int(),
  task_id: z.string(),
  run: z.union([z.string(), z.null()]),
});

export const TaskCreatedEventSchema = EventBase.extend({
  type: z.literal("task.created"),
  data: z.object({
    command: z.enum(["new-task", "test", "review", "design"]),
    title: z.string(),
    jira_key: z.union([z.string(), z.null()]),
  }),
});

export const TaskPhaseChangedEventSchema = EventBase.extend({
  type: z.literal("task.phase_changed"),
  data: z.object({
    from: z.union([z.string(), z.null()]),
    to: z.string(),
  }),
});

export const TaskRoundStartedEventSchema = EventBase.extend({
  type: z.literal("task.round_started"),
  data: z.object({ round: z.number().int() }),
});

export const TaskNoteAddedEventSchema = EventBase.extend({
  type: z.literal("task.note_added"),
  data: z.object({ note: z.unknown() }),
});

export const RunStartedEventSchema = EventBase.extend({
  type: z.literal("run.started"),
  data: z.object({
    role: z.string(),
    cli: z.string(),
    model: z.string(),
    effort: z.string(),
  }),
});

/** Added in Phase 1 milestone 6 (the concurrency limiter) -- not part of
 * Phase 0's original catalog, since nothing queued before this milestone.
 * See docs/app/contract/events.md. */
export const RunQueuedEventSchema = EventBase.extend({
  type: z.literal("run.queued"),
  data: z.object({ cli: z.string() }),
});
export const RunDequeuedEventSchema = EventBase.extend({
  type: z.literal("run.dequeued"),
  data: z.object({ cli: z.string() }),
});

export const RunFinishedEventSchema = EventBase.extend({
  type: z.literal("run.finished"),
  data: z.object({
    ok: z.boolean(),
    exit_code: z.union([z.number().int(), z.null()]),
    duration_s: z.union([z.number(), z.null()]),
    error: z.union([z.string(), z.null()]),
    usage: z.union([UsageSchema, z.null()]),
  }),
});

/** run.message / run.tool_call / run.tool_error share one `data` shape
 * (`{ text }`) -- see events.md's note on classify_log_entry()'s
 * prefix-based classification rather than per-CLI structured fields. */
const RunTextDataSchema = z.object({ text: z.string() });

export const RunMessageEventSchema = EventBase.extend({
  type: z.literal("run.message"),
  data: RunTextDataSchema,
});
export const RunToolCallEventSchema = EventBase.extend({
  type: z.literal("run.tool_call"),
  data: RunTextDataSchema,
});
export const RunToolErrorEventSchema = EventBase.extend({
  type: z.literal("run.tool_error"),
  data: RunTextDataSchema,
});

export const GateFinishedEventSchema = EventBase.extend({
  type: z.literal("gate.finished"),
  data: z.object({
    round: z.number().int(),
    ok: z.boolean(),
    steps: z.array(GateStepSchema),
  }),
});

export const GitWarningEventSchema = EventBase.extend({
  type: z.literal("git.warning"),
  data: z.object({ warning: z.string() }),
});

/** Added in Phase 3 milestone 5 -- `docs/app/phase-2-plan.md`'s open
 * question 4 proposed an `approval.*` event type before it existed
 * anywhere; Phase 2 milestone 2 corrected that (see
 * `packages/daemon/src/watcher.ts`'s old comment, removed alongside this
 * addition) since nothing emitted one at the time -- every approval
 * before this milestone was resolved purely via terminal prompts,
 * in-memory, never logged. This milestone makes `commit`/`integrate`/
 * `cleanup_worktree` (the only `ApprovalKind`s any caller of
 * `driveTask()` actually issues today -- see `packages/engine/src/
 * approvals.ts`) real, addressable HTTP pending-approval points, which
 * needs a real signal on the wire for the UI's inbox/notifications to
 * react to, not just a resolved `ApprovalDecision` nobody ever heard
 * about. `kind` is `string`, not `ApprovalKind`, deliberately: this
 * package has no dependency on `@crewbench/engine` (same reason
 * `schemas/api.ts`'s `ApiCliSchema` duplicates `@crewbench/adapters`'
 * CLI names instead of importing them) -- `packages/engine/src/drive.ts`
 * is the only writer and always passes a real `ApprovalKind`. **Not
 * emitted by the plugin**, same as `run.queued`/`run.dequeued`: the
 * Python dispatch script has no `ApprovalProvider`/`requestApproval()`
 * concept of its own, approvals there are the Team Lead's own terminal
 * prompts. */
export const ApprovalRequestedEventSchema = EventBase.extend({
  type: z.literal("approval.requested"),
  data: z.object({ id: z.string(), kind: z.string(), payload: z.unknown() }),
});
export const ApprovalResolvedEventSchema = EventBase.extend({
  type: z.literal("approval.resolved"),
  data: z.object({ id: z.string(), kind: z.string(), decision: z.enum(["yes", "no", "custom"]) }),
});

export const CrewbenchEventSchema = z.discriminatedUnion("type", [
  TaskCreatedEventSchema,
  TaskPhaseChangedEventSchema,
  TaskRoundStartedEventSchema,
  TaskNoteAddedEventSchema,
  RunStartedEventSchema,
  RunQueuedEventSchema,
  RunDequeuedEventSchema,
  RunFinishedEventSchema,
  RunMessageEventSchema,
  RunToolCallEventSchema,
  RunToolErrorEventSchema,
  GateFinishedEventSchema,
  GitWarningEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
]);
export type CrewbenchEvent = z.infer<typeof CrewbenchEventSchema>;
export type CrewbenchEventType = CrewbenchEvent["type"];
