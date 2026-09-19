import { describe, expect, it } from "vitest";
import {
  CodeReviewerResultSchema,
  CrewbenchEventSchema,
  DaemonConfigSchema,
  DeveloperResultSchema,
  ProjectSchema,
  SCHEMA_VERSION,
  TaskSpecSchema,
  TaskStateSchema,
  TesterResultSchema,
  UiUxResultSchema,
} from "../src/index.js";

describe("role result schemas", () => {
  it("parses a valid developer result", () => {
    const result = DeveloperResultSchema.parse({
      status: "done",
      summary: "did the thing",
      files_changed: ["a.ts"],
      assumptions: [],
      questions: [],
      blocked: [],
    });
    expect(result.status).toBe("done");
  });

  it("rejects an unknown top-level field (strict)", () => {
    expect(() =>
      DeveloperResultSchema.parse({
        status: "done",
        summary: "x",
        files_changed: [],
        assumptions: [],
        questions: [],
        blocked: [],
        extra: "nope",
      }),
    ).toThrow();
  });

  it("tester result allows an omitted screenshots field", () => {
    const result = TesterResultSchema.parse({
      verdict: "pass",
      summary: "ok",
      tests_run: [],
      tests_added: [],
      failures: [],
      blocked: [],
    });
    expect(result.screenshots).toBeUndefined();
  });

  it("code-reviewer result allows a missing previous_issues on round 1", () => {
    const result = CodeReviewerResultSchema.parse({
      verdict: "approve",
      summary: "ok",
      issues: [],
      blocked: [],
    });
    expect(result.previous_issues).toBeUndefined();
  });

  it("ui-ux result requires spec_markdown", () => {
    expect(() =>
      UiUxResultSchema.parse({
        status: "done",
        summary: "ok",
        reused_components: [],
        questions: [],
        blocked: [],
      }),
    ).toThrow();
  });
});

describe("TaskStateSchema", () => {
  it("parses a minimal valid state.json with schema_version present", () => {
    const state = TaskStateSchema.parse({
      schema_version: SCHEMA_VERSION,
      id: "20260918-1400-fix-login-a1b2",
      command: "new-task",
      title: "Fix login",
      created_at: "2026-09-18T14:00:00Z",
      updated_at: "2026-09-18T14:00:00Z",
      phase: "scoping",
      round: 0,
      lineup: {},
      base_commit: null,
      branch: null,
      worktree: null,
      acceptance_criteria: [],
      design_spec_file: null,
      rounds: [],
      usage: {},
      notes: [],
    });
    expect(state.phase).toBe("scoping");
  });

  it("parses a legacy state.json with no schema_version", () => {
    const state = TaskStateSchema.parse({
      id: "20250101-0000-legacy-task",
      command: "new-task",
      title: "Legacy",
      created_at: "2025-01-01T00:00:00",
      updated_at: "2025-01-01T00:00:00",
      phase: "done",
      round: 1,
      lineup: {},
      base_commit: null,
      branch: null,
      worktree: null,
      acceptance_criteria: [],
      design_spec_file: null,
      rounds: [],
      usage: {},
      notes: [],
    });
    expect(state.schema_version).toBeUndefined();
  });

  it("allows additional properties (additionalProperties: true, like the plugin's schema)", () => {
    const state = TaskStateSchema.parse({
      id: "x",
      command: "test",
      title: "T",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      phase: "done",
      round: 0,
      lineup: {},
      base_commit: null,
      branch: null,
      worktree: null,
      acceptance_criteria: [],
      design_spec_file: null,
      rounds: [],
      usage: {},
      notes: [],
      some_future_field: "ok",
    });
    expect((state as Record<string, unknown>).some_future_field).toBe("ok");
  });
});

describe("ProjectSchema", () => {
  it("parses an unconfirmed empty profile", () => {
    const project = ProjectSchema.parse({
      package_manager: null,
      install: null,
      commands: { lint: null, typecheck: null, test: null, test_changed: null, build: null, format_check: null },
      test_patterns: [],
      source_dirs: [],
      languages: [],
      frameworks: [],
      agy_allow_rules: [],
      confirmed: true,
    });
    expect(project.confirmed).toBe(true);
  });
});

describe("CrewbenchEventSchema", () => {
  it("parses a task.phase_changed event", () => {
    const event = CrewbenchEventSchema.parse({
      v: 1,
      ts: "2026-09-18T14:00:00Z",
      seq: 1,
      type: "task.phase_changed",
      task_id: "t1",
      run: null,
      data: { from: "scoping", to: "implementing" },
    });
    expect(event.type).toBe("task.phase_changed");
    if (event.type === "task.phase_changed") {
      expect(event.data.to).toBe("implementing");
    }
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      CrewbenchEventSchema.parse({
        v: 1,
        ts: "2026-09-18T14:00:00Z",
        seq: 1,
        type: "totally.unknown",
        task_id: "t1",
        run: null,
        data: {},
      }),
    ).toThrow();
  });
});

describe("TaskSpecSchema", () => {
  it("parses a minimal valid task-spec", () => {
    const spec = TaskSpecSchema.parse({
      title: "Fix login redirect",
      description: "The redirect goes to the wrong page after login.",
      acceptance_criteria: ["Redirects to /dashboard"],
      affected_areas: ["auth"],
      out_of_scope: [],
      needs_design: false,
      constraints: [],
    });
    expect(spec.needs_design).toBe(false);
  });
});

describe("DaemonConfigSchema", () => {
  // Regression: caught live in Phase 3 milestone 2, not by inspection --
  // z.record(z.enum([...]), ...) in zod v4 requires *every* enum key to
  // be present (it infers a full Record<K, V>, not Partial<Record<K,
  // V>>). A config.json with only `{claude: 1}` failed this schema's
  // validation and silently fell back to `{}` in loadConfig()'s own
  // safeParse failure path, so a concurrency limit configured for one
  // CLI was quietly ignored entirely -- the daemon ran fully unlimited
  // concurrency with no error, no log line, nothing. Fixed with
  // z.partialRecord(), zod's actual API for "some, not all, of these
  // keys."
  it("accepts a concurrency map naming only some CLIs, not every one", () => {
    const config = DaemonConfigSchema.parse({ concurrency: { claude: 1 } });
    expect(config.concurrency).toEqual({ claude: 1 });
  });

  it("rejects a non-positive concurrency limit", () => {
    expect(() => DaemonConfigSchema.parse({ concurrency: { claude: 0 } })).toThrow();
  });
});
