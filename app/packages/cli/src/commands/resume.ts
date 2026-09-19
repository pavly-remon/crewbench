import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdapter, type Cli } from "@crewbench/adapters";
import { listTasks, loadState, reconcileDeadRuns, rehydrateState } from "@crewbench/engine";
import type { TaskSpec } from "@crewbench/contract";
import { resolveLineup, type ResolvedLineup } from "../lineup.js";
import { defaultsPath } from "../root.js";
import { driveTask } from "../drive.js";

const LEAD_PREFERENCE: Cli[] = ["claude", "codex", "agy", "copilot"];

async function pickLeadCli(): Promise<Cli> {
  for (const cli of LEAD_PREFERENCE) {
    if ((await createAdapter(cli).doctor()).installed) return cli;
  }
  throw new Error("no crewbench-supported CLI (claude, codex, agy, copilot) was found on PATH");
}

/** `crewbench resume [task-id]` -- ported from `/crewbench:resume`'s
 * workflow (skills/resume/SKILL.md), now for real: reconciles any run
 * left `running` with a dead pid (step 3), rebuilds engine state from the
 * task's own on-disk round history (`rehydrateState()` -- see
 * `docs/app/phase-1-plan.md`'s milestone 6 note on why this replays
 * `runs/*.result.json`, not `events.jsonl`, and works identically for a
 * plugin-created task), and continues the fix loop with the lineup
 * already stored in `state.json.lineup` -- it does not re-ask the lineup
 * question, same as the plugin skill's step 5. */
export async function resumeCommand(argv: string[], root: string): Promise<void> {
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

  const taskState = await loadState(taskDir);
  console.log(`${taskState.title} (${taskState.id})`);
  console.log(`Last known phase: ${taskState.phase}, round ${taskState.round}.`);

  if (["done", "stopped", "failed"].includes(taskState.phase)) {
    console.log("This task already reached a terminal phase -- nothing to resume.");
    return;
  }

  const deadRuns = await reconcileDeadRuns(taskDir);
  for (const run of deadRuns) {
    console.log(`  ${run} was marked running but its process is gone -- marked failed.`);
  }

  // The lineup is already agreed (state.json.lineup) -- re-resolve only
  // the loop settings (max_rounds/fix_threshold aren't stored in
  // state.json itself, see schemas/task-state.json) from the same
  // defaults/team.json chain `run` used, per lib/dispatch.md §1.
  const leadCli = await pickLeadCli();
  const { loop } = await resolveLineup(defaultsPath(root), projectRoot, leadCli);

  const state = await rehydrateState(taskDir, loop);
  console.log(`Rehydrated to phase: ${state.phase}, round ${state.round}. Continuing...\n`);

  const spec: TaskSpec | null = taskState.spec_file && existsSync(taskState.spec_file as string)
    ? (JSON.parse(await readFile(taskState.spec_file as string, "utf-8")) as TaskSpec)
    : null;
  const taskText = spec?.description ?? taskState.title;
  const cwd = (taskState.worktree as string | null) ?? projectRoot;
  const lineupRoles = taskState.lineup as Record<string, { cli: Cli; model: string; effort: string; permissions: string }>;

  if (!lineupRoles || Object.keys(lineupRoles).length === 0) {
    console.log("This task has no saved lineup (it may predate Phase 1) -- cannot resume automatically.");
    return;
  }

  // state.json.lineup's shape matches ResolvedLineup.roles exactly by
  // construction (`run` writes it via `setField(taskDir, "lineup",
  // lineup.roles)` at creation time), but state.json's own contract type
  // is intentionally loose (Record<string, unknown> -- see
  // schemas/task-state.json), so a cast is needed to hand it back to
  // driveTask() in the shape it expects.
  const resolvedLineup = {
    roles: lineupRoles,
    loop,
    workspace: { mode: taskState.worktree ? ("worktree" as const) : ("in-place" as const), setup: [], copy: [] },
    confirmLineup: "never" as const,
  } as unknown as ResolvedLineup;

  await driveTask({
    state,
    taskDir,
    cwd,
    lineup: resolvedLineup,
    root,
    taskText,
    spec,
    title: taskState.title,
    projectRoot,
    base: (taskState.base_commit as string | null) ?? "HEAD",
    branch: taskState.branch as string | null,
    worktree: taskState.worktree as string | null,
    yes: false,
  });
}
