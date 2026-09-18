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

export const CrewbenchEventSchema = z.discriminatedUnion("type", [
  TaskCreatedEventSchema,
  TaskPhaseChangedEventSchema,
  TaskRoundStartedEventSchema,
  TaskNoteAddedEventSchema,
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunMessageEventSchema,
  RunToolCallEventSchema,
  RunToolErrorEventSchema,
  GateFinishedEventSchema,
  GitWarningEventSchema,
]);
export type CrewbenchEvent = z.infer<typeof CrewbenchEventSchema>;
export type CrewbenchEventType = CrewbenchEvent["type"];
