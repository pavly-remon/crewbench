import { readFileSync } from "node:fs";
import type { Cli, Usage } from "./types.js";
import type { Stream } from "./stream.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Best-effort token-count scan of plain-text CLI output, kept only as
 * copilot's fallback when --usage-output-file is missing (e.g. an older
 * copilot version without that flag). Ported from
 * crewbench_dispatch.py's USAGE_TEXT_PATTERNS / _usage_from_text(). */
const USAGE_TEXT_PATTERNS = [/tokens?\s*used[:\s]+([\d,]+)/i, /total\s*tokens[:\s]+([\d,]+)/i];

export function usageFromText(text: string | null | undefined): number | null {
  for (const pattern of USAGE_TEXT_PATTERNS) {
    const match = pattern.exec(text ?? "");
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1].replace(/,/g, ""), 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/** Whatever usage/cost data this run's CLI actually exposed -- every field
 * but duration_s may be null; a run's ok/error never depends on this being
 * complete. Ported field-for-field from crewbench_dispatch.py's
 * extract_usage(). `usageFile` is copilot's --usage-output-file, read here
 * (same as the Python version, which reads it inline) rather than by the
 * caller, since only this function knows its shape. */
export function extractUsage(cli: Cli, stream: Stream, stdout: string, durationS: number, usageFile?: string | null): Usage {
  const usage: Usage = {
    duration_s: durationS,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_usd: null,
    num_turns: null,
  };
  const final = isPlainObject(stream.final) ? stream.final : {};

  if (cli === "claude") {
    // Confirmed shape: Claude Code's documented stream-json terminal
    // `result` event (usage, total_cost_usd, num_turns).
    const raw = isPlainObject(final.usage) ? final.usage : {};
    usage.input_tokens = num(raw.input_tokens);
    usage.output_tokens = num(raw.output_tokens);
    if (usage.input_tokens !== null && usage.output_tokens !== null) {
      usage.total_tokens = usage.input_tokens + usage.output_tokens;
    }
    usage.cost_usd = num(final.total_cost_usd);
    usage.num_turns = num(final.num_turns);
  } else if (cli === "agy") {
    // Confirmed live: agy's terminal result event's usage:
    // {input_tokens, output_tokens, total_tokens, ...} and a top-level
    // num_turns. No cost field was present in that same live response, so
    // cost_usd stays a VERIFY guess.
    const raw = isPlainObject(final.usage) ? final.usage : {};
    usage.input_tokens = num(raw.input_tokens ?? raw.prompt_tokens);
    usage.output_tokens = num(raw.output_tokens ?? raw.completion_tokens);
    usage.total_tokens = num(raw.total_tokens);
    usage.cost_usd = num(final.cost_usd ?? final.cost);
    usage.num_turns = num(final.num_turns);
  } else if (cli === "codex") {
    // Confirmed live (codex-cli 0.154.0): the terminal turn.completed
    // event's usage: {input_tokens, cached_input_tokens,
    // cache_write_input_tokens, output_tokens, reasoning_output_tokens}.
    // No cost field present; num_turns isn't reported either.
    const raw = isPlainObject(final.usage) ? final.usage : {};
    usage.input_tokens = num(raw.input_tokens);
    usage.output_tokens = num(raw.output_tokens);
    if (usage.input_tokens !== null && usage.output_tokens !== null) {
      usage.total_tokens = usage.input_tokens + usage.output_tokens;
    }
  } else if (cli === "copilot") {
    // Confirmed live: --usage-output-file writes real per-session usage as
    // JSON -- lastCallInputTokens/lastCallOutputTokens (this run's call,
    // not a session total) and totalNanoAiu (an internal AI-unit credit
    // metric, not USD -- cost_usd stays null). Falls back to a
    // best-effort text scan if the file is missing.
    const data = readUsageFile(usageFile);
    if (data) {
      usage.input_tokens = num(data.lastCallInputTokens);
      usage.output_tokens = num(data.lastCallOutputTokens);
      if (usage.input_tokens !== null && usage.output_tokens !== null) {
        usage.total_tokens = usage.input_tokens + usage.output_tokens;
      }
    } else {
      usage.total_tokens = usageFromText(stdout);
    }
  }
  return usage;
}

function readUsageFile(path: string | null | undefined): Record<string, unknown> | null {
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
