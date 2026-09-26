/** Ported field-for-field from crewbench_dispatch.py's codex_strict_schema()
 * and normalize_optional_nulls() -- see that file for the full rationale
 * (OpenAI structured-outputs strict mode requires every `properties` key to
 * also be in `required`; codex gets a separate, transformed copy of the
 * schema rather than editing the canonical one, and the read side treats an
 * explicit optional-field `null` the same as "omitted"). This operates on
 * plain JSON-Schema-shaped objects (the output of z.toJSONSchema()), not
 * zod schemas directly -- codex's --output-schema flag takes a JSON Schema
 * file, not a zod object. */

// A JSON Schema node's shape is inherently dynamic (recursive, keyed by
// arbitrary property names) -- `any` here is the pragmatic choice a schema
// walker needs, not a shortcut around real typing elsewhere in this package.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchemaNode = Record<string, any>;

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex's `--output-schema` is passed straight through to OpenAI's
 * structured-outputs "strict" mode, which requires every key in an object's
 * `properties` to also appear in that object's `required` (confirmed live:
 * a schema with an optional top-level property, e.g. code-reviewer's
 * `previous_issues`, gets rejected with a 400 "'required' ... including
 * every key in properties" error before the model even runs). Our own
 * schemas intentionally leave some properties out of `required` (they're
 * genuinely optional -- omitted or empty when not applicable), so this
 * returns a *separate*, codex-only transformed copy: every property is
 * added to `required`, and any property that wasn't already required gets
 * `null` unioned into its `type` so the model can still supply nothing for
 * it in effect. */
export function codexStrictSchema<T extends JsonSchemaNode>(schema: T): T {
  const cloned = structuredClone(schema) as T;

  function walk(node: unknown): void {
    if (!isPlainObject(node)) return;
    if (node.type === "object" && isPlainObject(node.properties)) {
      const props = node.properties as JsonSchemaNode;
      const alreadyRequired = new Set<string>(Array.isArray(node.required) ? node.required : []);
      for (const [key, subschema] of Object.entries(props)) {
        if (!alreadyRequired.has(key) && isPlainObject(subschema)) {
          const t = subschema.type;
          if (Array.isArray(t) && !t.includes("null")) {
            subschema.type = [...t, "null"];
          } else if (typeof t === "string" && t !== "null") {
            subschema.type = [t, "null"];
          }
        }
        walk(subschema);
      }
      node.required = Object.keys(props);
    } else if (node.type === "array" && isPlainObject(node.items)) {
      walk(node.items);
    }
  }

  walk(cloned);
  return cloned;
}

/** Drop top-level keys whose value is `null` when that key isn't in the
 * schema's `required` list. Under OpenAI's structured-outputs strict mode,
 * codex must supply every property from its (codex-only) transformed
 * schema, so an optional field it has nothing to report for comes back as
 * an explicit `null` rather than simply missing. Our canonical schemas
 * define that field's *value*, when present, as (e.g.) an array, so
 * validation would otherwise reject the null. Treating an explicit
 * optional-field null the same as "omitted" keeps every CLI's result the
 * same shape, and is a no-op for any CLI that simply omits the key
 * instead. */
export function normalizeOptionalNulls(result: unknown, schema: JsonSchemaNode): unknown {
  if (!isPlainObject(result) || !isPlainObject(schema)) return result;
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(
    Object.entries(result).filter(([key, value]) => !(value === null && !required.has(key))),
  );
}
