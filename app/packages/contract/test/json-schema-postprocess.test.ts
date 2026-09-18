import { describe, expect, it } from "vitest";
import { z } from "zod";
import { collapseNullableAnyOf } from "../src/json-schema-postprocess.js";

// Regression coverage for a real bug caught during Phase 1 milestone 1:
// z.toJSONSchema() represents `z.union([z.number().int(), z.null()])` as
// `anyOf: [{type, minimum, maximum}, {type: "null"}]`, not a `type` array.
// crewbench_dispatch.py's hand-rolled validate_schema() only ever reads
// `schema.get("type")` -- it has no `anyOf` support -- so left uncollapsed,
// that field's type check silently no-ops and accepts *any* value.
describe("collapseNullableAnyOf", () => {
  it("collapses a nullable-integer union's anyOf into a type array, dropping the safe-integer bounds", () => {
    const NullableIntSchema = z.object({ line: z.union([z.number().int(), z.null()]) });
    const raw = z.toJSONSchema(NullableIntSchema) as Record<string, any>;
    // Confirm the bug scenario actually reproduces before asserting the fix
    // (otherwise this test would pass trivially if zod's output ever changes).
    expect(raw.properties.line.anyOf).toBeDefined();

    const collapsed = collapseNullableAnyOf(raw) as Record<string, any>;
    expect(collapsed.properties.line.anyOf).toBeUndefined();
    expect(collapsed.properties.line.type).toEqual(["integer", "null"]);
    expect(collapsed.properties.line.minimum).toBeUndefined();
    expect(collapsed.properties.line.maximum).toBeUndefined();
  });

  it("strips safe-integer bounds from a bare (non-union) integer field", () => {
    const RoundSchema = z.object({ round: z.number().int() });
    const raw = z.toJSONSchema(RoundSchema) as Record<string, any>;
    expect(raw.properties.round.minimum).toBeDefined(); // reproduces first

    const collapsed = collapseNullableAnyOf(raw) as Record<string, any>;
    expect(collapsed.properties.round).toEqual({ type: "integer" });
  });

  it("leaves a plain scalar union alone (zod already collapses it to a type array)", () => {
    const NullableStringSchema = z.object({ branch: z.union([z.string(), z.null()]) });
    const raw = z.toJSONSchema(NullableStringSchema) as Record<string, any>;
    expect(raw.properties.branch.anyOf).toBeUndefined();
    expect(raw.properties.branch.type).toEqual(["string", "null"]);

    const collapsed = collapseNullableAnyOf(raw) as Record<string, any>;
    expect(collapsed.properties.branch.type).toEqual(["string", "null"]);
  });

  it("leaves a non-scalar anyOf untouched (e.g. a nullable object union)", () => {
    const NullableObjectSchema = z.object({
      gate: z.union([z.object({ ok: z.boolean() }), z.null()]),
    });
    const raw = z.toJSONSchema(NullableObjectSchema) as Record<string, any>;
    expect(raw.properties.gate.anyOf).toBeDefined();

    const collapsed = collapseNullableAnyOf(raw) as Record<string, any>;
    expect(collapsed.properties.gate.anyOf).toBeDefined();
  });

  it("normalizes an empty-object additionalProperties to boolean true", () => {
    const RecordSchema = z.object({ notes: z.record(z.string(), z.unknown()) });
    const raw = z.toJSONSchema(RecordSchema) as Record<string, any>;
    expect(raw.properties.notes.additionalProperties).toEqual({});

    const collapsed = collapseNullableAnyOf(raw) as Record<string, any>;
    expect(collapsed.properties.notes.additionalProperties).toBe(true);
  });
});
