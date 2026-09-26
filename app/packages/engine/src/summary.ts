import type { FullEngineState } from "./reduce.js";

export interface RoleUsageSummaryInput {
  runs: number;
  duration_s: number | null;
  tokens: number | null;
  cost_usd: number | null;
  cli: string;
  model: string;
}

/** "6m12s" / "1h02m05s" / "45s" -- no fixed example in lib/dispatch.md §7
 * covers under a minute or over an hour, so this extends the pattern the
 * shown examples establish (minutes:seconds, seconds zero-padded to 2
 * digits) rather than guessing a different one for those cases. */
export function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function pluralRuns(n: number): string {
  return `${n} run${n === 1 ? "" : "s"}`;
}

/** One line: "developer · agy gemini-3.8-flash · 2 runs · 6m12s" or, for a
 * `host` cli, "tester · host (sonnet) · 1 run · 1m40s". Ported field-for-
 * field from lib/dispatch.md §7's "Usage summary" example. */
export function formatRoleLine(role: string, usage: RoleUsageSummaryInput): string {
  const cliPart = usage.cli === "host" ? `host (${usage.model})` : `${usage.cli} ${usage.model}`;
  const durationPart = usage.duration_s !== null ? formatDuration(usage.duration_s) : "—";
  return `${role} · ${cliPart} · ${pluralRuns(usage.runs)} · ${durationPart}`;
}

/** End-of-report usage summary: one line per role that actually ran (roles
 * with zero runs are omitted), then a total. Ported field-for-field from
 * lib/dispatch.md §7. */
export function usageSummary(usageByRole: Record<string, RoleUsageSummaryInput>): string {
  const lines: string[] = [];
  let totalRuns = 0;
  let totalDurationKnown = false;
  let totalDuration = 0;

  for (const [role, usage] of Object.entries(usageByRole)) {
    if (!usage.runs) continue;
    lines.push(formatRoleLine(role, usage));
    totalRuns += usage.runs;
    if (usage.duration_s !== null) {
      totalDuration += usage.duration_s;
      totalDurationKnown = true;
    }
  }

  const totalDurationPart = totalDurationKnown ? formatDuration(totalDuration) : "—";
  lines.push(`total: ${pluralRuns(totalRuns)} · ${totalDurationPart}`);
  return lines.join("\n");
}

/** A plain-language, deterministic report built from final engine state --
 * no LLM involved. This is the fallback summarizeTask() always has
 * available, per docs/app/phase-1-plan.md's milestone 5 scope ("a hard
 * deterministic fallback summary if [the LLM] call fails, so a task's
 * outcome is never unreported over an LLM-call hiccup"). */
export function deterministicSummary(
  taskTitle: string,
  state: FullEngineState,
  usageByRole: Record<string, RoleUsageSummaryInput>,
): string {
  const lines: string[] = [`${taskTitle}: ${outcomeLine(state)}`];

  const resolvedIssues = state.issueRegistry.filter((i) => i.status === "resolved");
  const stillOpenIssues = state.issueRegistry.filter((i) => i.status !== "resolved");
  if (resolvedIssues.length > 0) {
    lines.push(`Resolved ${resolvedIssues.length} issue${resolvedIssues.length === 1 ? "" : "s"} across ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"}.`);
  }
  if (state.phase === "stopped" && state.stuckReason) {
    lines.push(`Stopped: ${state.stuckReason}.`);
    if (stillOpenIssues.length > 0) {
      lines.push(`Still open: ${stillOpenIssues.map((i) => `${i.id} (${i.file})`).join(", ")}.`);
    }
  }
  if (state.optionalFollowUps.length > 0) {
    lines.push(
      `Optional follow-ups (below the fix threshold, not acted on): ${state.optionalFollowUps
        .map((i) => `${i.id} (${i.file}, ${i.severity})`)
        .join(", ")}.`,
    );
  }

  lines.push("", usageSummary(usageByRole));
  return lines.join("\n");
}

function outcomeLine(state: FullEngineState): string {
  switch (state.phase) {
    case "done":
      return "done.";
    case "stopped":
      return "stopped.";
    case "failed":
      return "failed.";
    default:
      return `in progress (phase: ${state.phase}, round ${state.round}).`;
  }
}

/** A function that turns the deterministic report into plain language via
 * an LLM call (through the "lead" CLI -- see docs/app/phase-1-plan.md's
 * open question 2). Injected rather than hard-wired to a specific CLI, so
 * summarizeTask() is testable without spawning a real process. */
export type LlmSummarizer = (deterministicReport: string) => Promise<string>;

/** Turns the deterministic report into plain language via `callLlm`, with
 * a hard fallback to the deterministic report itself if that call throws,
 * times out, or returns something empty -- a task's outcome is never
 * unreported over an LLM-call hiccup. */
export async function summarizeTask(
  taskTitle: string,
  state: FullEngineState,
  usageByRole: Record<string, RoleUsageSummaryInput>,
  callLlm?: LlmSummarizer,
): Promise<string> {
  const deterministic = deterministicSummary(taskTitle, state, usageByRole);
  if (!callLlm) return deterministic;
  try {
    const prose = await callLlm(deterministic);
    return prose && prose.trim() ? prose : deterministic;
  } catch {
    return deterministic;
  }
}
