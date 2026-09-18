#!/usr/bin/env node
/** Generates the repo's root schemas/*.json from this package's zod
 * schemas -- the zod schema is the single source of truth; the JSON file is
 * generated, checked in, and CI fails the build if it's out of date (see
 * app/package.json's `check:schemas` script). The Python side
 * (crewbench_dispatch.py's validate()) keeps reading these same files
 * unchanged -- this script never moves or renames them. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  CodeReviewerResultSchema,
  DeveloperResultSchema,
  ProjectSchema,
  TaskStateSchema,
  TesterResultSchema,
  UiUxResultSchema,
} from "../src/index.js";
import { collapseNullableAnyOf } from "../src/json-schema-postprocess.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// app/packages/contract/scripts -> repo root: up four levels.
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SCHEMAS_DIR = resolve(REPO_ROOT, "schemas");

interface Target {
  file: string;
  schema: z.ZodType;
  /** Matches the hand-written top-level "description" key the Python-side
   * files (task-state.json, project.json) carry today -- role-result files
   * have no top-level description, only per-field ones (handled by each
   * schema's own .describe() calls). */
  description?: string;
}

const TARGETS: Target[] = [
  {
    file: "task-state.json",
    schema: TaskStateSchema,
    description:
      "One .crewbench/tasks/<task-id>/state.json. Written and read by bin/crewbench_state.py; " +
      "see lib/dispatch.md's state.json section for the field-by-field protocol (when the Team " +
      "Lead updates each one).",
  },
  {
    file: "project.json",
    schema: ProjectSchema,
    description:
      "One .crewbench/project.json. Proposed by bin/crewbench_profile.py detect; written only " +
      "after the user confirms it via /crewbench:profile (or the first new-task in a project " +
      "without one) — see lib/dispatch.md §0's 'Project profile' section. Loose like " +
      "task-state.json: additionalProperties stays true since this file already goes through a " +
      "human-confirmation step rather than the strict role-schema contract.",
  },
  { file: "developer.json", schema: DeveloperResultSchema },
  { file: "tester.json", schema: TesterResultSchema },
  { file: "code-reviewer.json", schema: CodeReviewerResultSchema },
  { file: "ui-ux.json", schema: UiUxResultSchema },
];

function generate(target: Target): unknown {
  let jsonSchema = z.toJSONSchema(target.schema, { target: "draft-7" }) as Record<string, unknown>;
  // z.toJSONSchema() adds "$schema" -- the existing hand-written files don't
  // carry one, so drop it to keep the generated files minimal and diffable.
  delete jsonSchema.$schema;
  jsonSchema = collapseNullableAnyOf(jsonSchema) as Record<string, unknown>;
  if (target.description) {
    // Re-insert "description" right after "type", matching the existing
    // files' key order, since JSON key order is otherwise insertion order
    // and toJSONSchema() puts "type" first.
    const { type, ...rest } = jsonSchema;
    return { type, description: target.description, ...rest };
  }
  return jsonSchema;
}

for (const target of TARGETS) {
  const jsonSchema = generate(target);
  const outPath = resolve(SCHEMAS_DIR, target.file);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(jsonSchema, null, 2) + "\n", "utf-8");
  console.log(`wrote ${outPath}`);
}
