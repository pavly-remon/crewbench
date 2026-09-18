import { z } from "zod";

/** Ported field-for-field from schemas/project.json. additionalProperties
 * stays true (via .catchall) -- this file already goes through a human
 * confirmation step (lib/dispatch.md §0's "Project profile"), so it's loose
 * by design, unlike the strict per-role result schemas. */
export const ProjectCommandsSchema = z
  .object({
    lint: z.union([z.string(), z.null()]).optional(),
    typecheck: z.union([z.string(), z.null()]).optional(),
    test: z.union([z.string(), z.null()]).optional(),
    test_changed: z.union([z.string(), z.null()]).optional(),
    build: z.union([z.string(), z.null()]).optional(),
    format_check: z.union([z.string(), z.null()]).optional(),
  })
  .strict();
export type ProjectCommands = z.infer<typeof ProjectCommandsSchema>;

export const ProjectSchema = z
  .object({
    package_manager: z.union([z.string(), z.null()]),
    install: z.union([z.string(), z.null()]),
    commands: ProjectCommandsSchema,
    test_patterns: z.array(z.string()),
    source_dirs: z.array(z.string()),
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    /** Suggested-only command(...) allow rules for
     * ~/.gemini/antigravity-cli/settings.json -- the app must never write
     * that file itself, same as the plugin (lib/dispatch.md §0). */
    agy_allow_rules: z.array(z.string()),
    detected_at: z.union([z.string(), z.null()]).optional(),
    /** true once the user has confirmed or corrected the detected proposal
     * at least once. Never write project.json before this is true. */
    confirmed: z.boolean(),
  })
  .catchall(z.unknown());
export type Project = z.infer<typeof ProjectSchema>;
