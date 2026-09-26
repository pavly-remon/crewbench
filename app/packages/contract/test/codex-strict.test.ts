import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexStrictSchema, normalizeOptionalNulls } from "../src/codex-strict.js";

// Ported from tests/test_codex_strict_schema.py -- same fixture files (the
// root schemas/*.json), same cases, so both language ports stay provably
// in sync with each other.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(__dirname, "..", "..", "..", "..", "schemas");

function readSchema(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(SCHEMAS_DIR, name), "utf-8"));
}

describe("codexStrictSchema", () => {
  it("adds every property to required", () => {
    const schema = readSchema("code-reviewer.json");
    const strict = codexStrictSchema(schema);
    expect(new Set(strict.required)).toEqual(new Set(Object.keys(strict.properties)));
  });

  it("unions null into newly-required optional fields, leaves already-required fields alone", () => {
    const schema = readSchema("code-reviewer.json");
    const strict = codexStrictSchema(schema);
    expect(strict.properties.previous_issues.type).toEqual(["array", "null"]);
    expect(strict.properties.issues.type).toBe("array");
  });

  it("recurses into array items", () => {
    const schema = readSchema("code-reviewer.json");
    const strict = codexStrictSchema(schema);
    const itemSchema = strict.properties.issues.items;
    expect(new Set(itemSchema.required)).toEqual(new Set(Object.keys(itemSchema.properties)));
  });

  it("does not mutate the canonical schema", () => {
    const schema = readSchema("code-reviewer.json");
    const originalRequired = [...schema.required];
    codexStrictSchema(schema);
    expect(schema.required).toEqual(originalRequired);
    expect(schema.required).not.toContain("previous_issues");
  });

  it("on the tester schema, handles screenshots", () => {
    const schema = readSchema("tester.json");
    const strict = codexStrictSchema(schema);
    expect(strict.required).toContain("screenshots");
    expect(strict.properties.screenshots.type).toEqual(["array", "null"]);
  });
});

describe("normalizeOptionalNulls", () => {
  it("drops a null optional field", () => {
    const schema = readSchema("code-reviewer.json");
    const result = { verdict: "approve", summary: "x", issues: [], blocked: [], previous_issues: null };
    const normalized = normalizeOptionalNulls(result, schema) as Record<string, unknown>;
    expect("previous_issues" in normalized).toBe(false);
  });

  it("keeps a required field even if null", () => {
    const schema = readSchema("code-reviewer.json");
    const result = { verdict: "approve", summary: "x", issues: null, blocked: [] };
    const normalized = normalizeOptionalNulls(result, schema) as Record<string, unknown>;
    expect(normalized.issues).toBeNull();
  });

  it("keeps a real optional value", () => {
    const schema = readSchema("code-reviewer.json");
    const previousIssues = [{ id: "R1-1", status: "resolved", note: "fixed" }];
    const result = { verdict: "approve", summary: "x", issues: [], blocked: [], previous_issues: previousIssues };
    const normalized = normalizeOptionalNulls(result, schema) as Record<string, unknown>;
    expect(normalized.previous_issues).toEqual(previousIssues);
  });
});
