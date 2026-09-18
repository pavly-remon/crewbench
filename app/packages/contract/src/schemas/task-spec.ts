import { z } from "zod";

/** NEW in Phase 1 -- not written by the plugin. Output of the engine's
 * scoping step; stored at .crewbench/tasks/<task-id>/spec.json, pointed to
 * by state.json.spec_file (see docs/app/phase-1-plan.md's open question 3
 * and task-state.ts's spec_file field). Shape per
 * docs/app/CONTEXT.md's Phase 1 prompt. */
export const TaskSpecSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    acceptance_criteria: z.array(z.string()),
    affected_areas: z.array(z.string()),
    out_of_scope: z.array(z.string()),
    needs_design: z.boolean(),
    design_notes: z.string().optional(),
    jira_key: z.union([z.string(), z.null()]).optional(),
    constraints: z.array(z.string()),
  })
  .strict();
export type TaskSpec = z.infer<typeof TaskSpecSchema>;
