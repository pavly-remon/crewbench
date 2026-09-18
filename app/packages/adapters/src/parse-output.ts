import { readFileSync } from "node:fs";
import type { Cli } from "./types.js";
import type { Stream } from "./stream.js";
import { extractJson } from "./json-extract.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ported field-for-field from crewbench_dispatch.py's parse_output().
 * `extraOutputFile` is codex's --output-schema/-o file (the source of
 * truth for its structured result) -- see build-command.ts. */
export function parseOutput(
  cli: Cli,
  stream: Stream,
  stdout: string,
  extraOutputFile: string | null,
): { result: unknown; denials: unknown[]; error: string | null } {
  if (cli === "claude" || cli === "agy") {
    const final = stream.final;
    if (final === null) {
      return { result: null, denials: [], error: "no result event in output" };
    }
    const denials = Array.isArray(final.permission_denials)
      ? final.permission_denials
      : Array.isArray(final.denied_actions)
        ? final.denied_actions
        : [];
    if (isPlainObject(final.structured_output)) {
      return { result: final.structured_output, denials, error: null };
    }
    if (final.is_error || (final.status !== undefined && final.status !== null && final.status !== "SUCCESS")) {
      const message = final.result ?? final.error ?? final.status;
      return { result: null, denials, error: String(message) };
    }
    const text = typeof final.result === "string" ? final.result : typeof final.response === "string" ? final.response : "";
    return { result: extractJson(text), denials, error: null };
  }

  if (cli === "codex") {
    const lastMessage = extraOutputFile ? tryReadFile(extraOutputFile) : null;
    if (lastMessage !== null) {
      return { result: extractJson(lastMessage), denials: [], error: null };
    }
    const final = isPlainObject(stream.final) ? stream.final : {};
    if (isPlainObject(final.error)) {
      const error = final.error;
      return { result: null, denials: [], error: String(error.message ?? JSON.stringify(error)) };
    }
    return { result: null, denials: [], error: "no result event in output" };
  }

  return { result: extractJson(stdout), denials: [], error: null };
}

function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
