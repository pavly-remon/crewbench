/** Post-processes z.toJSONSchema()'s output so it stays compatible with
 * crewbench_dispatch.py's hand-rolled validate_schema() (which only
 * understands `type`/`enum`/`required`/`properties`/`additionalProperties`/
 * `items` -- no `anyOf`, no JSON Schema features beyond that subset). See
 * collapseNullableAnyOf()'s docstring for the specific bug this fixes. */

const MIN_SAFE_INT = Number.MIN_SAFE_INTEGER;
const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;

function isEmptySchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

/** True for a JSON Schema node that's just `{ type: "<scalar>" }`, plus
 * z.number().int()'s default safe-integer `minimum`/`maximum` bounds (which
 * collapseNullableAnyOf() also strips) -- i.e. a node it can safely fold
 * into a `type` array entry. */
function isPlainScalarNode(node: unknown): node is { type: string } {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return false;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (typeof obj.type !== "string") return false;
  if (keys.length === 1) return true;
  const onlyExtra = keys.filter((k) => k !== "type");
  return (
    onlyExtra.every((k) => k === "minimum" || k === "maximum") &&
    obj.minimum === MIN_SAFE_INT &&
    obj.maximum === MAX_SAFE_INT
  );
}

/** crewbench_dispatch.py's hand-rolled validate_schema() only ever reads a
 * node's `type` (string or array) -- it has no concept of JSON Schema's
 * `anyOf`. A nullable union whose non-null branch carries extra keywords
 * (z.number().int()'s minimum/maximum bounds are the only case that arises
 * in this package's schemas) makes z.toJSONSchema() emit `anyOf: [{type,
 * minimum, maximum}, {type: "null"}]` instead of the simple `type: [T,
 * "null"]` array it uses for a plain scalar union (e.g. string-or-null
 * collapses on its own, with no `anyOf` at all). Left as `anyOf`, the
 * Python validator's `schema.get("type")` would be `None` and it would
 * stop checking that field's type entirely -- silently accepting any
 * value, not just T-or-null (confirmed live: without this fix, a
 * code-reviewer `issues[].line` of `"not-a-number"` was accepted instead of
 * rejected). This collapses exactly that pattern back into the `type`
 * array form (dropping the safe-integer bounds, which the original
 * hand-written schemas never had either), and leaves any other `anyOf`
 * shape untouched (e.g. task-state.json's `rounds[].gate`, a union with a
 * full object branch -- none of these arise in the role-result schemas
 * validate_schema() actually validates against). */
export function collapseNullableAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(collapseNullableAnyOf);
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;

  if (Array.isArray(obj.anyOf) && obj.anyOf.length >= 2 && obj.anyOf.every(isPlainScalarNode)) {
    const types = (obj.anyOf as { type: string }[]).map((branch) => branch.type);
    const { anyOf: _anyOf, ...rest } = obj;
    return collapseNullableAnyOf({ ...rest, type: types });
  }

  // Same safe-integer bounds, but on a bare (non-union) integer field --
  // e.g. "round": { type: "integer", minimum, maximum } -- strip for the
  // same reason: not in the hand-written originals, and harmless to drop
  // since validate_schema() never reads minimum/maximum at all.
  if (obj.type === "integer" && obj.minimum === MIN_SAFE_INT && obj.maximum === MAX_SAFE_INT) {
    const { minimum: _min, maximum: _max, ...rest } = obj;
    return collapseNullableAnyOf(rest);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "additionalProperties" && isEmptySchema(value)) {
      // z.unknown()/z.record(...)'s JSON Schema is `{}` ("any value"),
      // functionally identical to the boolean `true` the hand-written
      // files use (validate_schema() only ever branches on `is False`),
      // but noisier and inconsistent with the existing convention.
      out[key] = true;
    } else {
      out[key] = collapseNullableAnyOf(value);
    }
  }
  return out;
}
