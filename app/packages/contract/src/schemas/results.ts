import { z } from "zod";
import { BlockedActionSchema } from "./common.js";

/** Ported field-for-field from schemas/developer.json, including its
 * per-field descriptions (kept as .describe() so the generated JSON Schema
 * matches the original's documentation, not just its structure). */
export const DeveloperResultSchema = z
  .object({
    status: z.enum(["done", "blocked", "needs_clarification"]),
    summary: z.string().describe("Short plain-language summary of what you built."),
    files_changed: z.array(z.string()).describe("Paths of files you created, edited or deleted."),
    assumptions: z.array(z.string()).describe("Assumptions you made."),
    questions: z.array(z.string()).describe("Ambiguities the Team Lead or user should resolve."),
    blocked: z
      .array(BlockedActionSchema)
      .describe(
        "Actions you needed but could not perform because they were denied or sandboxed " +
          "(e.g. installing a package, network access). Empty if none.",
      ),
  })
  .strict();
export type DeveloperResult = z.infer<typeof DeveloperResultSchema>;

/** Ported field-for-field from schemas/tester.json. */
export const TestFailureSchema = z
  .object({
    test: z.string(),
    file: z.string(),
    expected: z.string(),
    actual: z.string(),
    reason: z.string(),
  })
  .strict();
export type TestFailure = z.infer<typeof TestFailureSchema>;

export const TesterResultSchema = z
  .object({
    verdict: z.enum(["pass", "fail", "error"]),
    summary: z.string(),
    tests_run: z.array(z.string()).describe("Test commands or test names you ran."),
    tests_added: z.array(z.string()).describe("Test files you created or changed."),
    failures: z.array(TestFailureSchema),
    blocked: z
      .array(BlockedActionSchema)
      .describe(
        "Actions you needed but could not perform because they were denied or sandboxed " +
          "(e.g. installing a package, network access). Empty if none.",
      ),
    screenshots: z
      .array(z.string())
      .optional()
      .describe(
        "Optional. Paths under .crewbench/tasks/<task-id>/screenshots/ from an opt-in " +
          "Playwright visual check (see lib/dispatch.md's 'Visual verification'). Omit or " +
          "leave empty when not applicable.",
      ),
  })
  .strict();
export type TesterResult = z.infer<typeof TesterResultSchema>;

/** Ported field-for-field from schemas/code-reviewer.json. */
export const IssueSchema = z
  .object({
    id: z.string().describe('Stable id for tracking this issue across rounds, e.g. "R1-3" (round 1, 3rd issue).'),
    file: z.string(),
    line: z.union([z.number().int(), z.null()]),
    severity: z.enum(["blocker", "major", "minor"]),
    category: z.enum(["correctness", "security", "consistency", "maintainability"]),
    change: z.string().describe("The specific, actionable change to make."),
  })
  .strict();
export type Issue = z.infer<typeof IssueSchema>;

export const PreviousIssueSchema = z
  .object({
    id: z.string().describe('The id from the previous round\'s issue, e.g. "R1-3".'),
    status: z.enum(["resolved", "still_present"]),
    note: z.string(),
  })
  .strict();
export type PreviousIssue = z.infer<typeof PreviousIssueSchema>;

export const CodeReviewerResultSchema = z
  .object({
    verdict: z.enum(["approve", "changes_requested"]),
    summary: z.string(),
    issues: z.array(IssueSchema),
    previous_issues: z
      .array(PreviousIssueSchema)
      .optional()
      .describe("Only present from round 2 on: the status of each issue from the previous round's `issues`."),
    blocked: z
      .array(BlockedActionSchema)
      .describe(
        "Actions you needed but could not perform because they were denied or sandboxed " +
          "(e.g. installing a package, network access). Empty if none.",
      ),
  })
  .strict();
export type CodeReviewerResult = z.infer<typeof CodeReviewerResultSchema>;

/** Ported field-for-field from schemas/ui-ux.json. */
export const UiUxResultSchema = z
  .object({
    status: z.enum(["done", "needs_clarification"]),
    summary: z.string(),
    spec_markdown: z
      .string()
      .describe("The full design spec: layout and components, states (loading, empty, error, success), interactions."),
    reused_components: z.array(z.string()).describe("Existing project components/patterns the spec reuses."),
    questions: z.array(z.string()).describe("Open questions."),
    blocked: z
      .array(BlockedActionSchema)
      .describe(
        "Actions you needed but could not perform because they were denied or sandboxed " +
          "(e.g. installing a package, network access). Empty if none.",
      ),
  })
  .strict();
export type UiUxResult = z.infer<typeof UiUxResultSchema>;

/** Keyed the same way schemas/<role>.json's filenames are, so `result_file`
 * validation can pick the right schema by role name at runtime -- there is
 * no discriminated union on the result object itself, since real CLI output
 * carries no role-tag field (the envelope's own `role` field is that tag). */
export const ROLE_RESULT_SCHEMAS = {
  developer: DeveloperResultSchema,
  tester: TesterResultSchema,
  "code-reviewer": CodeReviewerResultSchema,
  "ui-ux": UiUxResultSchema,
} as const;
export type RoleName = keyof typeof ROLE_RESULT_SCHEMAS;
export const ROLE_NAMES = ["developer", "tester", "code-reviewer", "ui-ux"] as const satisfies readonly RoleName[];
export const RoleNameSchema = z.enum(ROLE_NAMES);
