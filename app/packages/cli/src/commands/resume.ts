import { existsSync } from "node:fs";
import { join } from "node:path";
import { listTasks, loadState } from "@crewbench/engine";

/** `crewbench resume [task-id]` -- this milestone (Phase 1 milestone 5)
 * only reports where a task stands; rebuilding engine state from
 * events.jsonl and actually continuing the fix loop is
 * docs/app/phase-1-plan.md's milestone 6 ("Resume: rebuild state by
 * replaying events.jsonl"). Reporting honestly what's implemented here
 * rather than a half-working continuation. */
export async function resumeCommand(argv: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const crewbenchDir = join(projectRoot, ".crewbench");
  let taskId = argv[0];

  if (!taskId) {
    const rows = await listTasks(crewbenchDir);
    const unfinished = rows.find((r) => !["done", "stopped", "failed"].includes(r.phase ?? ""));
    if (!unfinished) {
      console.log("No unfinished task to resume.");
      return;
    }
    taskId = unfinished.id;
  }

  const taskDir = join(crewbenchDir, "tasks", taskId);
  if (!existsSync(join(taskDir, "state.json"))) {
    console.log(`No such task: ${taskId}`);
    return;
  }
  const state = await loadState(taskDir);
  console.log(`${state.title} (${state.id})`);
  console.log(`Last known phase: ${state.phase}, round ${state.round}.`);
  console.log(
    "Full resume (rebuilding engine state from events.jsonl and continuing the fix loop) lands in " +
      "milestone 6 -- see docs/app/phase-1-plan.md. For now, `crewbench status " +
      state.id +
      "` shows what's recorded.",
  );
}
