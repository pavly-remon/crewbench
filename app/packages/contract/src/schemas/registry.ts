import { z } from "zod";

/** `~/.crewbench/projects.json` -- the daemon's project registry (Phase 2
 * milestone 1). App-only: the plugin has no notion of "registered
 * projects" (a plugin skill always operates on `process.cwd()`), so this
 * file is never read by any `bin/*.py` script and has no Python-side
 * schema to port from. Keyed by project id (not array-indexed) so
 * add/remove are simple object operations without a linear scan, mirroring
 * `.crewbench/index.json`'s own shape (task id -> entry). */
export const RegisteredProjectSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    name: z.string(),
    added_at: z.string(),
  })
  .strict();
export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;

export const ProjectsRegistrySchema = z.record(z.string(), RegisteredProjectSchema);
export type ProjectsRegistry = z.infer<typeof ProjectsRegistrySchema>;

/** `~/.crewbench/config.json` -- daemon-wide settings. Phase 2 milestone 1
 * only reads `port`; the other fields are shaped in now per
 * docs/app/phase-2-plan.md's open question 3, so Phase 4's "global config"
 * work is additive to this file, not a breaking rewrite of it. */
export const DaemonConfigSchema = z
  .object({
    port: z.number().int().optional(),
  })
  .catchall(z.unknown());
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
