import { z } from "zod";
import { ROLE_KEYS, RoleLineupSchema } from "./team.js";

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
    /** Per-CLI max concurrent runs across every task in every project
     * (Phase 3 milestone 2's Design decision 2, `docs/app/phase-3-plan.md`)
     * -- passed to `packages/engine`'s `ConcurrencyLimiter`, one shared
     * instance per daemon process. Any CLI not listed here keeps
     * `ConcurrencyLimiter`'s own built-in default (2). **Real bug, caught
     * live, not by inspection**: `z.record(z.enum([...]), ...)` in zod v4
     * requires *every* enum key to be present (it infers a full
     * `Record<K, V>`, not `Partial<Record<K, V>>`) -- a config.json with
     * only `{claude: 1}` failed validation and silently fell back to `{}`
     * (`loadConfig()`'s own `safeParse` failure path), so a limit set for
     * one CLI was quietly ignored entirely. `z.partialRecord()` is zod's
     * actual API for "some, not all, of these keys." */
    concurrency: z.partialRecord(z.enum(["claude", "codex", "agy", "copilot"]), z.number().int().positive()).optional(),
    /** Phase 4 milestone 4 (Design decision 5): the lineup step's own
     * pre-fill (`lineup-defaults.ts`'s `suggestLineup()`) already reads a
     * *project's* `team.json` for this same shape -- `default_lineup`
     * here is the one-level-higher, machine-wide fallback for a project
     * that has no `team.json` of its own yet, reusing `team.ts`'s own
     * `RoleLineupSchema` rather than a parallel type (same real value,
     * same real shape, just scoped to the whole daemon instead of one
     * project). */
    default_lineup: z.partialRecord(z.enum(ROLE_KEYS), RoleLineupSchema).optional(),
    /** Mirrors Phase 3 milestone 5's existing *client-side-only*
     * `localStorage` opt-in for desktop notifications
     * (`lib/notifications.ts`'s own `OPT_IN_KEY`) -- persisted here as
     * the daemon-wide *default* a fresh browser tab/profile starts from,
     * not a replacement for the per-viewer `localStorage` flag (Design
     * decision 8's own "client-side only" principle is unchanged; this
     * is what a brand-new tab's own `useApprovalNotifications()` should
     * seed its local opt-in state from, a wiring this milestone doesn't
     * itself do -- see the milestone log for why). */
    notifications: z.boolean().optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .catchall(z.unknown());
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
