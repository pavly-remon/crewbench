import { z } from "zod";
import { SchemaVersionSchema } from "./common.js";
import { RoleNameSchema } from "./results.js";

/** Ported from crewbench_dispatch.py main()'s envelope dict, built up over
 * the run (not written to a single JSON Schema file on the Python side --
 * `result` validates against schemas/<role>.json separately, at the point
 * validate() is called). See lib/dispatch.md §4's numbered envelope
 * example and "Usage and timing" section. */
export const UsageSchema = z
  .object({
    duration_s: z.union([z.number(), z.null()]),
    input_tokens: z.union([z.number(), z.null()]),
    output_tokens: z.union([z.number(), z.null()]),
    total_tokens: z.union([z.number(), z.null()]),
    cost_usd: z.union([z.number(), z.null()]),
    num_turns: z.union([z.number().int(), z.null()]),
  })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;

export const DispatchEnvelopeSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    role: RoleNameSchema,
    cli: z.enum(["claude", "codex", "agy", "copilot"]),
    model: z.string(),
    effort: z.string(),
    skip_permissions: z.boolean().optional(),
    ok: z.boolean(),
    exit_code: z.union([z.number().int(), z.null()]),
    duration_s: z.union([z.number(), z.null()]),
    /** Validate against ROLE_RESULT_SCHEMAS[role] separately -- see
     * results.ts's comment on why there is no role-tagged union here. */
    result: z.unknown(),
    usage: z.union([UsageSchema, z.null()]),
    permission_denials: z.array(z.unknown()),
    error: z.union([z.string(), z.null()]),
    warnings: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
    session_id: z.union([z.string(), z.null()]),
    resume_command: z.union([z.string(), z.null()]),
    result_file: z.string(),
    log_file: z.string(),
    raw_output_file: z.string(),
  })
  .catchall(z.unknown());
export type DispatchEnvelope = z.infer<typeof DispatchEnvelopeSchema>;
