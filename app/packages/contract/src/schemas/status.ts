import { z } from "zod";
import { SchemaVersionSchema } from "./common.js";

/** No JSON Schema file on the Python side -- internal to
 * crewbench_dispatch.py's update_status()/_read_status(). Ported here from
 * its usage sites (cmd_start, the pre-run update_status call, finish(),
 * cmd_cancel) so the TS runner writes byte-compatible entries. See
 * docs/app/contract/README.md's "tasks/<task-id>/runs/status.json" section. */
export const RunStatusSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    state: z.enum(["starting", "running", "done", "failed"]),
    pid: z.number().int().optional(),
    launcher_pid: z.number().int().optional(),
    role: z.string().optional(),
    cli: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    started_at: z.string().optional(),
    finished_at: z.string().optional(),
    log_file: z.string().optional(),
    session_id: z.union([z.string(), z.null()]).optional(),
    resume_command: z.union([z.string(), z.null()]).optional(),
    error: z.union([z.string(), z.null()]).optional(),
  })
  .catchall(z.unknown());
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** <task-dir>/runs/status.json: { "<role>-r<round>": RunStatus } */
export const RunStatusFileSchema = z.record(z.string(), RunStatusSchema);
export type RunStatusFile = z.infer<typeof RunStatusFileSchema>;
