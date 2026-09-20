import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdapter, type Cli } from "@crewbench/adapters";
import { driveTask, listTasks, loadState, reconcileDeadRuns, rehydrateState, type DriveTaskLineup } from "@crewbench/engine";
import type { TaskSpec } from "@crewbench/contract";
import { resolveLineup } from "../lineup.js";
import { agentsDir, defaultsPath, schemaPath } from "../root.js";
import { createTerminalApprovalProvider } from "../terminal-approvals.js";

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

  // Phase 4 milestone 3, a real, disclosed, pre-existing bug this
  // milestone's own embedded-terminal work found live, not invented:
  // this check used to bail out for "stopped"/"failed" too, matching
  // skills/resume/SKILL.md's *original*, plugin-only-workflow intent
  // (§1: offer only a task whose phase is "not done/stopped/failed" --
  // once stopped, a human must intervene some other way). But Phase 3
  // milestone 6 established a real, reviewed-and-approved, genuinely
  // *different* meaning for those two phases in the daemon-hosted flow:
  // routes/task-control.ts's own `POST .../resume` explicitly treats
  // "stopped"/"failed" as the resumable set (rejecting only anything
  // else), the whole reason TaskControls' in-app Resume button exists.
  // task-controls.tsx's own CopyResumeCommand claims to build "the exact
  // same resume" for running from a terminal instead -- but until this
  // fix, pasting that exact command into a terminal for a stopped/failed
  // task silently printed this message and exited, doing nothing at
  // all. Confirmed by actually running it, not assumed: this milestone's
  // own real test drives `crewbench resume` against a task in phase
  // "stopped" and checks the real process output. Narrowed to bail out
  // for "done" only, matching the daemon route's own already-approved
  // resumable set exactly.
  if (taskState.phase === "done") {
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

  // state.json.lineup's shape matches DriveTaskLineup.roles exactly by
  // construction (`run` writes it via `setField(taskDir, "lineup",
  // lineup.roles)` at creation time), but state.json's own contract type
  // is intentionally loose (Record<string, unknown> -- see
  // schemas/task-state.json), so a cast is needed to hand it back to
  // driveTask() in the shape it expects.
  const driveLineup: DriveTaskLineup = { roles: lineupRoles as DriveTaskLineup["roles"], loop };

  await driveTask({
    state,
    taskDir,
    cwd,
    lineup: driveLineup,
    agentsDir: agentsDir(root),
    schemaPathFor: (role) => schemaPath(root, role),
    taskText,
    spec,
    title: taskState.title,
    projectRoot,
    base: (taskState.base_commit as string | null) ?? "HEAD",
    branch: taskState.branch as string | null,
    worktree: taskState.worktree as string | null,
    approvals: createTerminalApprovalProvider(),
    yes: false,
  });
}
