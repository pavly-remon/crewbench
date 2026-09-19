/** Ported field-for-field from crewbench_dispatch.py's extract_json():
 * find the last top-level JSON object in free text. Tries, in order: the
 * whole text as JSON, the last fenced ```json block, then a raw scan for
 * the last top-level `{...}` object. */
export function extractJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();

  const whole = tryParseObject(trimmed);
  if (whole) return whole;

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    const block = fenced[i]?.[1];
    if (block) {
      const parsed = tryParseObject(block);
      if (parsed) return parsed;
    }
  }

  return lastTopLevelObject(trimmed);
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Scans for every `{` and tries to parse a JSON value starting there,
 * keeping the last top-level object found -- mirrors Python's
 * json.JSONDecoder().raw_decode() loop, since JS's JSON.parse has no
 * "parse a prefix and tell me where it stopped" mode. */
function lastTopLevelObject(text: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const decoded = rawDecodeObject(text, i);
    if (decoded) found = decoded.value;
  }
  return found;
}

/** Attempts to parse one JSON value starting at `start`, returning it plus
 * where it ended, or null if `start` isn't the beginning of valid JSON.
 * Implemented by shrinking the end of a growing slice until JSON.parse
 * accepts it would be O(n^2)-ish; instead this walks a simple bracket/
 * string-aware scanner to find the matching close brace directly. */
function rawDecodeObject(text: string, start: number): { value: Record<string, unknown> } | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        const parsed = tryParseObject(candidate);
        return parsed ? { value: parsed } : null;
      }
    }
  }
  return null;
}

/** Ported from crewbench_dispatch.py's short(): collapse whitespace and
 * truncate to `limit` chars with a trailing ellipsis. */
export function short(value: unknown, limit = 160): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value);
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit - 1) + "…";
}
