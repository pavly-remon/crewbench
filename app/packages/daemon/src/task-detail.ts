import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadState, rehydrateState } from "@crewbench/engine";
import type { ApiRoleUsage, ApiTaskDetail, DispatchEnvelope } from "@crewbench/contract";
import type { TaskLocation } from "./watcher.js";
import { resolveLoopSettings } from "./loop-settings.js";

async function readJsonSafe<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Sums every recorded run's `usage` (Phase 2 milestone 4's own scope,
 * picking up `drive.ts`'s "per-role usage aggregation is daemon/Phase-2
 * territory" comment from Phase 1). Reads every
 * `runs/<role>-r<round>.result.json` envelope directly rather than going
 * through `rehydrateState()` -- that function replays envelopes through
 * `reduce()` to reconstruct *engine* state (phase/rounds/issues), and has
 * no reason to also thread per-envelope usage numbers through the same
 * pure state machine. A `null` component makes the whole rollup `null`
 * for that field (never silently 0), matching this repo's `cost_usd:
 * null` convention from Phase 0. */
async function aggregateUsage(taskDir: string): Promise<Record<string, ApiRoleUsage>> {
  const runsDir = join(taskDir, "runs");
  let files: string[] = [];
  try {
    files = await readdir(runsDir);
  } catch {
    return {};
  }

  const usage: Record<string, ApiRoleUsage> = {};
  for (const file of files) {
    if (!file.endsWith(".result.json")) continue;
    const envelope = await readJsonSafe<DispatchEnvelope>(join(runsDir, file));
    if (!envelope) continue;
    const role = envelope.role;
    const existing = usage[role] ?? {
      runs: 0,
      duration_s: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cost_usd: null,
      cli: envelope.cli,
      model: envelope.model,
    };
    existing.runs += 1;
    const u = envelope.usage;
    if (u) {
      existing.duration_s = sumNullable(existing.duration_s, u.duration_s);
      existing.input_tokens = sumNullable(existing.input_tokens, u.input_tokens);
      existing.output_tokens = sumNullable(existing.output_tokens, u.output_tokens);
      existing.total_tokens = sumNullable(existing.total_tokens, u.total_tokens);
      existing.cost_usd = sumNullable(existing.cost_usd, u.cost_usd);
    }
    usage[role] = existing;
  }
  return usage;
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Assembles `GET /api/tasks/:tid`'s response: `state.json` fields as-is,
 * `rounds`/`issues` from replaying the task's own recorded envelopes
 * through the exact engine `rehydrateState()` already uses for `crewbench
 * resume` (Phase 1 milestone 6) -- one source of truth for "what actually
 * happened round by round," not a second parallel reconstruction. */
export async function buildTaskDetail(location: TaskLocation): Promise<ApiTaskDetail> {
  const state = await loadState(location.taskDir);
  const loop = await resolveLoopSettings(location.projectPath);
  const rehydrated = await rehydrateState(location.taskDir, loop);
  const usage = await aggregateUsage(location.taskDir);

  const specPath = state.spec_file ? join(location.taskDir, state.spec_file) : null;
  const spec = specPath ? await readJsonSafe<unknown>(specPath) : null;

  return {
    id: state.id,
    title: state.title,
    phase: rehydrated.phase,
    round: rehydrated.round,
    branch: state.branch,
    worktree: state.worktree,
    base_commit: state.base_commit,
    jira_key: state.jira_key ?? null,
    notes: state.notes,
    created_at: state.created_at,
    updated_at: state.updated_at,
    stuck_reason: rehydrated.stuckReason,
    lineup: state.lineup,
    rounds: rehydrated.rounds,
    issues: rehydrated.issueRegistry,
    usage,
    spec,
  };
}
