import { describe, expect, it } from "vitest";
import { extractJson } from "../src/json-extract.js";

// Ported from tests/test_extract_json.py.
describe("extractJson", () => {
  it("parses a plain object", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("extracts a fenced json block", () => {
    const text = 'Here is my answer:\n```json\n{"a": 1, "b": [1,2]}\n```\nDone.';
    expect(extractJson(text)).toEqual({ a: 1, b: [1, 2] });
  });

  it("prefers the last fenced block", () => {
    const text = '```json\n{"a": 1}\n```\nActually:\n```json\n{"a": 2}\n```';
    expect(extractJson(text)).toEqual({ a: 2 });
  });

  it("finds an object embedded in prose", () => {
    const text = 'I did the thing. {"status": "done", "files_changed": []} That is all.';
    expect(extractJson(text)).toEqual({ status: "done", files_changed: [] });
  });

  it("prefers the last top-level object", () => {
    expect(extractJson('{"a": 1} some text {"a": 2}')).toEqual({ a: 2 });
  });

  it("returns null for no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
  });

  it("returns null for empty/missing input", () => {
    expect(extractJson("")).toBeNull();
    expect(extractJson(null)).toBeNull();
    expect(extractJson(undefined)).toBeNull();
  });

  it("ignores a non-object top-level value", () => {
    expect(extractJson("[1, 2, 3]")).toBeNull();
  });
});
