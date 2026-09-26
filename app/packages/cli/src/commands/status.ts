import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listTasks, loadState } from "@crewbench/engine";

/** `crewbench status [task-id]` -- ported in spirit from
 * skills/status/SKILL.md: no argument lists recent tasks; a task id shows
 * phase/round/lineup/usage. Read-only, same as the plugin skill. */
export async function statusCommand(argv: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const crewbenchDir = join(projectRoot, ".crewbench");
  const taskId = argv[0];

  if (!taskId) {
    const rows = await listTasks(crewbenchDir);
    if (rows.length === 0) {
      console.log("No tasks yet.");
      return;
    }
    console.log("id".padEnd(38) + "phase".padEnd(16) + "round".padEnd(7) + "title");
    for (const row of rows) {
      console.log((row.id ?? "").padEnd(38) + (row.phase ?? "").padEnd(16) + String(row.round ?? "").padEnd(7) + (row.title ?? ""));
    }
    return;
  }

  const taskDir = join(crewbenchDir, "tasks", taskId);
  if (!existsSync(join(taskDir, "state.json"))) {
    console.log(`No such task: ${taskId}`);
    return;
  }
  const state = await loadState(taskDir);
  console.log(`${state.title} (${state.id})`);
  console.log(`phase: ${state.phase}   round: ${state.round}`);
  console.log(`branch: ${state.branch ?? "(in-place)"}   worktree: ${state.worktree ?? "(none)"}`);
  if (state.notes.length > 0) {
    console.log("notes:");
    for (const note of state.notes) console.log(`  - ${note}`);
  }
  const statusPath = join(taskDir, "runs", "status.json");
  if (existsSync(statusPath)) {
    const runs = JSON.parse(await readFile(statusPath, "utf-8")) as Record<string, { state?: string; resume_command?: string }>;
    console.log("runs:");
    for (const [run, info] of Object.entries(runs)) {
      console.log(`  ${run}: ${info.state ?? "?"}${info.resume_command ? ` (resume: ${info.resume_command})` : ""}`);
    }
  }
}
