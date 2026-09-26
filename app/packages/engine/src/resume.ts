import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateResult, LoopSettings, ReviewerResult, TesterResult } from "./types.js";
import { initialState, reduce, type FullEngineState } from "./reduce.js";
import { loadState } from "./task-store.js";
import { atomicWriteJson, nowIso, readJsonOrDefault } from "./contract-fs.js";

/** True if `pid` names a live process -- `process.kill(pid, 0)` sends no
 * actual signal, it only checks whether the OS would deliver one. Ported
 * in spirit from `/crewbench:resume`'s step 3 ("check whether its pid is
 * still alive"); on POSIX this is exact, on Windows Node emulates it well
 * enough for this purpose (VERIFY against a real Windows run, same
 * caveat every other POSIX-first piece of this codebase carries). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** For any run in `<taskDir>/runs/status.json` marked `running` whose pid
 * is dead, marks it `failed` instead of leaving it to be waited on
 * forever -- ported from `/crewbench:resume`'s step 3 and
 * `docs/app/phase-1-plan.md`'s milestone 6 scope ("Detect runs marked
 * running whose pid is dead, and offer to re-dispatch them" -- the
 * "offer to re-dispatch" half is the CLI's job, this function only does
 * the detection+reconciliation). Returns the run names that were marked
 * failed. */
export async function reconcileDeadRuns(taskDir: string): Promise<string[]> {
  const statusPath = join(taskDir, "runs", "status.json");
  const status = await readJsonOrDefault<Record<string, Record<string, unknown>>>(statusPath, {});
  const deadRuns: string[] = [];
  for (const [run, info] of Object.entries(status)) {
    const pid = info.pid;
    if (info.state === "running" && typeof pid === "number" && !isPidAlive(pid)) {
      deadRuns.push(run);
      status[run] = { ...info, state: "failed", error: "process no longer running (found on resume)", finished_at: nowIso() };
    }
  }
  if (deadRuns.length > 0) {
    await atomicWriteJson(statusPath, status);
  }
  return deadRuns;
}

async function readResultFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

interface RunEnvelope<T> {
  ok: boolean;
  result: T | null;
}

/** Rebuilds engine state for a task already on disk, whether it was
 * created by the plugin or by this app -- both write the identical
 * `runs/<role>-r<round>.result.json` / `runs/gate-r<round>.result.json`
 * file family (docs/app/contract/README.md), which is what this function
 * actually replays. **Deviates from the literal "replay events.jsonl"
 * phrasing in docs/app/phase-1-plan.md's milestone 6 scope, for a real
 * reason, not silently**: `events.jsonl`'s `run.finished` event only
 * carries `{ok, exit_code, duration_s, error, usage}` -- not the role's
 * full structured `result` -- so it can't by itself reconstruct a
 * tester/reviewer verdict or the issue registry. The round-by-round
 * `.result.json` files are the actual source of truth for those, and are
 * exactly what a live run itself reads to fold into `state.json.rounds[]`
 * -- so replaying *those*, through the exact same `reduce()` the live
 * engine uses, is both more correct and more consistent than a
 * separate/parallel "history reconstruction" code path would be. A
 * legacy plugin task with no `events.jsonl` at all (see
 * `docs/app/contract/events.md`'s "Legacy tasks" note) rehydrates exactly
 * the same way, since this never reads `events.jsonl` in the first place. */
export async function rehydrateState(taskDir: string, loop: LoopSettings): Promise<FullEngineState> {
  const taskState = await loadState(taskDir);
  const needsDesign = Boolean(taskState.design_spec_file);
  let state = reduce(initialState(), { type: "start", needsDesign, loop });
  if (needsDesign) {
    state = reduce(state, { type: "design.finished" });
  }

  const runsDir = join(taskDir, "runs");
  const attemptedRounds = Math.max(taskState.round, state.round);
  for (let round = 1; round <= attemptedRounds; round++) {
    const developerEnvelope = await readResultFile<RunEnvelope<unknown>>(join(runsDir, `developer-r${round}.result.json`));
    if (!developerEnvelope) break; // nothing recorded past this point -- stop replaying

    state = reduce(state, { type: "developer.finished" });

    const gate = await readResultFile<GateResult>(join(runsDir, `gate-r${round}.result.json`));
    if (gate) {
      state = reduce(state, { type: "gate.finished", gate });
      if (!gate.ok) continue; // gate short-circuit: no verification ran this round
    }

    const testerEnvelope = await readResultFile<RunEnvelope<TesterResult>>(join(runsDir, `tester-r${round}.result.json`));
    const reviewerEnvelope = await readResultFile<RunEnvelope<ReviewerResult>>(join(runsDir, `code-reviewer-r${round}.result.json`));
    if (testerEnvelope && reviewerEnvelope) {
      const tester: TesterResult =
        testerEnvelope.ok && testerEnvelope.result ? testerEnvelope.result : { verdict: "error", failures: [] };
      const reviewer: ReviewerResult =
        reviewerEnvelope.ok && reviewerEnvelope.result ? reviewerEnvelope.result : { verdict: "changes_requested", issues: [] };
      state = reduce(state, { type: "verification.finished", tester, reviewer });
    }
  }

  return state;
}
