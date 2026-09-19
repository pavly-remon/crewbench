import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  driveTask,
  isPidAlive,
  listTasks,
  loadState,
  reconcileDeadRuns,
  readJsonOrDefault,
  rehydrateState,
  type ApprovalDecision,
  type ApprovalRequest,
  type DriveTaskLineup,
  type DriveTaskParams,
} from "@crewbench/engine";
import type { Cli, Effort, Permissions } from "@crewbench/adapters";
import type { RoleName, TaskSpec, TaskState } from "@crewbench/contract";
import type { DaemonWatcher } from "./watcher.js";
import { resolveLoopSettings } from "./loop-settings.js";
import { agentsDir, findRoot, schemaPath } from "./root.js";
import { HttpApprovalProvider } from "./approval-provider.js";

interface ActiveTask {
  approvals: HttpApprovalProvider;
  promise: Promise<void>;
}

interface StatusEntry {
  state?: string;
  pid?: number;
}

/** Owns one in-flight `driveTask()` loop per active, app-owned task
 * (Phase 3 milestone 1's Design decision 1) and the reattach-on-restart
 * logic (Design decision 3). Never touches a task whose `state.json`
 * `owner` isn't exactly `"app"` -- a plugin-created or `crewbench
 * run`-created task is driven by its own process, and the daemon must
 * never also try to drive it (docs/app/CONTEXT.md's ownership model,
 * carried into Phase 3 by Design decision 5). */
export class TaskRunner {
  private readonly active = new Map<string, ActiveTask>();
  private readonly root: string;

  constructor(private readonly watcher: DaemonWatcher) {
    this.root = findRoot();
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  listPendingApprovals(taskId: string): ApprovalRequest[] {
    return this.active.get(taskId)?.approvals.listPending() ?? [];
  }

  resolveApproval(taskId: string, approvalId: string, decision: ApprovalDecision): boolean {
    return this.active.get(taskId)?.approvals.resolve(approvalId, decision) ?? false;
  }

  /** Starts driving a task that's ready to go *right now* -- either a
   * brand-new task (milestone 3's task-creation endpoint) or one whose
   * reattach found nothing still in flight. Fire-and-forget by design:
   * `driveTask()` runs for as long as the task's fix loop takes, and its
   * own progress is observable through the same events.jsonl/SSE path
   * every other run already uses (Phase 2), not through this promise. */
  private start(taskId: string, params: DriveTaskParams): void {
    const approvals = params.approvals as HttpApprovalProvider;
    const promise = driveTask(params)
      .catch((err: unknown) => {
        console.error(`task ${taskId}: driveTask() failed:`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.active.delete(taskId);
      });
    this.active.set(taskId, { approvals, promise });
  }

  /** Rebuilds `DriveTaskParams` purely from what's already on disk --
   * `state.json.lineup` is the lineup this task actually runs with (set
   * once at creation, never re-resolved against a possibly-changed
   * `team.json`, same rule `crewbench resume` already follows). Loop
   * settings are the one thing not persisted anywhere
   * (docs/app/phase-2-plan.md's `loop-settings.ts` already documents
   * this same real gap for read-only display; reused here verbatim for
   * the same reason -- there is nothing more authoritative to read). */
  private async buildParams(taskId: string, taskDir: string, projectPath: string, taskState: TaskState): Promise<DriveTaskParams> {
    const loop = await resolveLoopSettings(projectPath);
    const state = await rehydrateState(taskDir, loop);

    const lineupRoles = taskState.lineup as Record<RoleName, { cli: Cli; model: string; effort: Effort; permissions: Permissions }>;
    const lineup: DriveTaskLineup = { roles: lineupRoles, loop };

    const specPath = taskState.spec_file ? join(taskDir, taskState.spec_file) : null;
    const spec: TaskSpec | null = specPath && existsSync(specPath) ? (JSON.parse(await readFile(specPath, "utf-8")) as TaskSpec) : null;

    return {
      state,
      taskDir,
      cwd: taskState.worktree ?? projectPath,
      lineup,
      agentsDir: agentsDir(this.root),
      schemaPathFor: (role) => schemaPath(this.root, role),
      taskText: spec?.description ?? taskState.title,
      spec,
      title: taskState.title,
      projectRoot: projectPath,
      base: taskState.base_commit ?? "HEAD",
      branch: taskState.branch,
      worktree: taskState.worktree,
      approvals: new HttpApprovalProvider(),
      yes: false,
    };
  }

  /** Reattaches every app-owned, non-terminal task in one project --
   * called once per project at daemon startup, and again whenever a
   * project is newly registered (covers a project that already has an
   * in-flight app-owned task from a previous daemon instance that
   * crashed, not just the common "daemon restarted with the same
   * registry" case). */
  async reattachProject(projectPath: string): Promise<void> {
    const rows = await listTasks(join(projectPath, ".crewbench"));
    for (const row of rows) {
      if (!row.id) continue;
      const taskDir = join(projectPath, ".crewbench", "tasks", row.id);
      let taskState: TaskState;
      try {
        taskState = await loadState(taskDir);
      } catch {
        continue; // an index.json entry with no readable state.json -- skip, don't crash reattach for every other task
      }
      if (taskState.owner !== "app") continue;
      if (["done", "stopped", "failed"].includes(taskState.phase)) continue;
      await this.reattachOne(row.id, taskDir, projectPath, taskState);
    }
  }

  private async reattachOne(taskId: string, taskDir: string, projectPath: string, taskState: TaskState): Promise<void> {
    // Marks any run stuck at "running" with a genuinely dead pid as
    // failed (Phase 1 milestone 6's reconcileDeadRuns(), functional for
    // the first time as of this milestone's pid-recording fix in
    // runner.ts) -- must run before the still-alive check below, so a
    // stale "running" entry from a truly dead process never gets treated
    // as still in flight.
    await reconcileDeadRuns(taskDir);

    const status = await readJsonOrDefault<Record<string, StatusEntry>>(join(taskDir, "runs", "status.json"), {});
    const stillRunning = Object.entries(status).find(
      ([, info]) => info.state === "running" && typeof info.pid === "number" && isPidAlive(info.pid),
    );

    const params = await this.buildParams(taskId, taskDir, projectPath, taskState);

    if (!stillRunning) {
      this.start(taskId, params);
      return;
    }

    // Design decision 3: don't call driveTask() while a real dispatch is
    // still in flight (decide() would re-issue the same command,
    // dispatching a second, redundant copy of it). Instead wait for that
    // exact run's own run.finished event -- already emitted by
    // dispatchRole() before this daemon ever existed, and already tailed
    // by the watcher (Phase 2) -- then rebuild params fresh (so
    // rehydrateState() picks up the now-completed round) and start.
    const [runName] = stillRunning;
    const onTaskEvent = (tid: string, event: { type: string; run: string | null }): void => {
      if (tid !== taskId || event.type !== "run.finished" || event.run !== runName) return;
      this.watcher.off("task-event", onTaskEvent);
      this.buildParams(taskId, taskDir, projectPath, taskState)
        .then((freshParams) => this.start(taskId, freshParams))
        .catch((err: unknown) => console.error(`task ${taskId}: failed to resume after reattach:`, err));
    };
    this.watcher.on("task-event", onTaskEvent);
  }
}
