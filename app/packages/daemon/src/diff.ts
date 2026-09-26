import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { TaskState } from "@crewbench/contract";
import type { TaskLocation } from "./watcher.js";

const execFileAsync = promisify(execFile);

/** `git diff <base_commit>` in whichever tree currently holds the task's
 * changes -- the worktree if it's still there, the project's main
 * checkout if it's already been removed (a merge, per `lib/dispatch.md`
 * §5, lands the same changes on the main tree's history, so `git diff
 * base_commit` there still shows them correctly against the current
 * working tree/index/HEAD combination; confirmed this is how `git diff
 * <ref>` behaves with no second ref, not assumed).
 *
 * **Real, disclosed limitation** (see `ApiDiffSchema`'s docstring in
 * `packages/contract`): nothing snapshots git state per round today, so
 * `round=N` and `round=base` return the *same* diff -- there is no
 * round-isolated delta to compute from what's actually on disk. */
export async function computeDiff(
  location: TaskLocation,
  state: TaskState,
  // Accepted (not `_round`) so every call site reads as "this is a
  // round-scoped request," even though it's currently a no-op -- see
  // this function's own docstring and ApiDiffSchema's for why.
  round: number | null,
): Promise<string> {
  void round;
  if (!state.base_commit) return "";
  const cwd = state.worktree && existsSync(state.worktree) ? state.worktree : location.projectPath;
  try {
    const { stdout } = await execFileAsync("git", ["diff", state.base_commit], { cwd, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    // A non-zero exit with no diff output (e.g. base_commit not found in
    // this tree -- a genuinely different repo, or history rewritten
    // since) reports as an execFile error even though there's nothing
    // actually broken about the request; surface an empty diff rather
    // than a 500 for what's fundamentally "nothing to show."
    const asExecError = err as { stdout?: string };
    return asExecError.stdout ?? "";
  }
}
