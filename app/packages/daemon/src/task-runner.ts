import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConcurrencyLimiter,
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
  /** Phase 3 milestone 6's cancel control -- one per active task,
   * signaled by `cancelTask()`. */
  controller: AbortController;
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
/** Real concurrency bug caught by review, not this repo's own testing:
 * two concurrent callers racing to start the same task (two `POST
 * .../lineup` submissions, or a resume racing a reattach) could both
 * pass an `!isActive()` check, both await `buildParams()`'s real disk
 * I/O, and both end up calling `start()` -- the second's `active.set()`
 * silently overwriting the first's map entry, leaving one `driveTask()`
 * loop running fully untracked while both mutate the same task
 * directory. A route catches this to return 409, not 500 -- it's a real,
 * expected outcome of a genuine race, not a server error. */
export class TaskAlreadyStartingError extends Error {
  constructor(public readonly taskId: string) {
    super(`task ${taskId} is already starting or active -- a concurrent request got there first`);
    this.name = "TaskAlreadyStartingError";
  }
}

export class TaskRunner {
  private readonly active = new Map<string, ActiveTask>();
  /** Reserves a taskId the instant a caller commits to starting it,
   * before any `await` -- closing the exact race `TaskAlreadyStartingError`'s
   * own docstring describes. `isActive()` treats a reservation exactly
   * like a fully active task (both mean "don't let anyone else start
   * this"), so a route's own `!isActive()` guard stays correct without
   * having to know this set exists. Emptied either by `start()` (the
   * task graduates from "reserved" to "active") or by the reserving
   * call's own cleanup if it throws before reaching `start()`. */
  private readonly reserving = new Set<string>();
  private readonly root: string;
  /** One shared instance across every active task in this daemon
   * process (Design decision 2 -- "one shared ConcurrencyLimiter per
   * daemon process, not per project or per task"), so a per-CLI limit
   * genuinely caps concurrency across every project the daemon watches,
   * not just within one task's own dispatches. */
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly watcher: DaemonWatcher,
    concurrency: Partial<Record<Cli, number>> = {},
  ) {
    this.root = findRoot();
    this.limiter = new ConcurrencyLimiter(concurrency);
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId) || this.reserving.has(taskId);
  }

  listPendingApprovals(taskId: string): ApprovalRequest[] {
    return this.active.get(taskId)?.approvals.listPending() ?? [];
  }

  /** Every pending approval across every currently active, app-owned
   * task in this daemon process (Phase 3 milestone 5's global "needs
   * you" inbox, `GET /api/approvals`) -- iterates `this.active` rather
   * than needing a separate index, since a pending approval only ever
   * exists inside an in-flight `driveTask()` loop's own
   * `HttpApprovalProvider`, and `this.active` already tracks exactly
   * that set. Purely in-memory, like `HttpApprovalProvider` itself: a
   * daemon restart loses no *state* (the task's own `state.json`/`phase`
   * on disk is what actually says "waiting on an approval" -- see
   * `routes/approvals.ts`'s docstring), just the in-flight
   * `driveTask()` call that would re-request the same approval again
   * once reattach resumes it. */
  listAllPendingApprovals(): Array<{ taskId: string; request: ApprovalRequest }> {
    const result: Array<{ taskId: string; request: ApprovalRequest }> = [];
    for (const [taskId, entry] of this.active) {
      for (const request of entry.approvals.listPending()) {
        result.push({ taskId, request });
      }
    }
    return result;
  }

  resolveApproval(taskId: string, approvalId: string, decision: ApprovalDecision): boolean {
    return this.active.get(taskId)?.approvals.resolve(approvalId, decision) ?? false;
  }

  /** Phase 3 milestone 6: signals the active task's `driveTask()` loop
   * (`DriveTaskParams.cancelSignal`, checked once per iteration) to stop
   * before its next command rather than continuing to another round.
   * Returns whether a live loop was actually there to signal -- `false`
   * means `routes/task-control.ts` has no in-process loop to rely on for
   * persisting the cancelled outcome, and must write `state.json`'s
   * `phase` itself instead. Does **not** kill any in-flight subprocess on
   * its own (`cancelSignal` can't interrupt an `await` already in
   * progress -- see `DriveTaskParams.cancelSignal`'s own docstring); the
   * caller does that separately via the engine's real `cancelRun()`
   * against `status.json`'s pid. */
  cancelTask(taskId: string): boolean {
    const entry = this.active.get(taskId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** Starts a task for the very first time, once its lineup has actually
   * been chosen (Phase 3 milestone 4's `POST /api/tasks/:tid/lineup`,
   * after `setField(taskDir, "lineup", ...)` has already persisted it) --
   * the only public entry point that begins driving a task that was
   * never running before, as opposed to `reattachProject()`'s own
   * `start()` calls, which resume one already mid-flight. Reuses
   * `buildParams()`/`start()` unchanged: by the time this is called,
   * `state.json` already has a real, non-empty `lineup`, so this is
   * structurally the same as any reattach that found nothing still
   * running, just reached from a fresh task instead of a restart.
   *
   * Reserves `taskId` synchronously, before the first `await`, so two
   * concurrent calls for the same task can't both slip past their own
   * `!isActive()` check and both reach `start()` -- see
   * `TaskAlreadyStartingError`'s own docstring for the real race this
   * closes. Throws that error immediately (no async work happens at all)
   * for the loser of that race, rather than silently overwriting the
   * winner's `active` entry. */
  async startTask(taskId: string, taskDir: string, projectPath: string, taskState: TaskState): Promise<void> {
    if (!this.reserve(taskId)) throw new TaskAlreadyStartingError(taskId);
    try {
      const params = await this.buildParams(taskId, taskDir, projectPath, taskState);
      this.start(taskId, params);
    } catch (err) {
      this.reserving.delete(taskId);
      throw err;
    }
  }

  /** Synchronous check-and-reserve -- see `TaskAlreadyStartingError`'s
   * own docstring. Returns `false` (reserving nothing) if the task is
   * already active or already reserved by a concurrent caller; the
   * caller must not proceed to `buildParams()`/`start()` in that case. */
  private reserve(taskId: string): boolean {
    if (this.active.has(taskId) || this.reserving.has(taskId)) return false;
    this.reserving.add(taskId);
    return true;
  }

  /** Starts driving a task that's ready to go *right now* -- either a
   * brand-new task with a lineup already chosen (`startTask()`) or one
   * whose reattach found nothing still in flight. Fire-and-forget by
   * design: `driveTask()` runs for as long as the task's fix loop takes,
   * and its own progress is observable through the same events.jsonl/SSE
   * path every other run already uses (Phase 2), not through this
   * promise. */
  private start(taskId: string, params: DriveTaskParams): void {
    const approvals = params.approvals as HttpApprovalProvider;
    const controller = new AbortController();
    const promise = driveTask({ ...params, cancelSignal: controller.signal })
      .catch((err: unknown) => {
        console.error(`task ${taskId}: driveTask() failed:`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        this.active.delete(taskId);
      });
    this.active.set(taskId, { approvals, promise, controller });
    // Graduated from "reserved" to "active" -- both synchronous, same
    // tick, so `isActive()` never has a window where it would wrongly
    // read false between the two.
    this.reserving.delete(taskId);
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

    // spec_file is always an absolute path (see task-detail.ts's
    // buildTaskDetail() docstring for the same real bug, fixed there and
    // here together) -- joining it onto taskDir a second time would
    // silently resolve to a nonexistent path.
    const specPath = (taskState.spec_file as string | null | undefined) ?? null;
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
      limiter: this.limiter,
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
      // Real, live bug found while building milestone 4's lineup step,
      // fixed here rather than shipped further: an app-owned task sits
      // in "scoping" -- a non-terminal phase -- for the entire scoping-
      // chat/spec-editor/lineup-step flow now that milestone 4 makes that
      // flow span real time (a user can legitimately leave a task
      // half-set-up across a daemon restart). Before this fix,
      // `reattachOne()` ran unconditionally on such a task: `buildParams()`
      // calls `rehydrateState()`, which unconditionally reduces
      // `{type: "start"}` and gets *persisted* to `state.json`'s `phase`
      // by `driveTask()`'s own first two lines -- silently corrupting a
      // never-started task's on-disk phase from "scoping" to "design"/
      // "implementing" -- and then `driveTask()` itself would throw
      // reading `lineup.roles.developer.cli` off an empty `{}` lineup,
      // caught only by `start()`'s own `.catch()` and logged to console,
      // never surfaced to the user. Mirrors `task-detail.ts`'s own
      // `hasLineup` guard (Phase 3 milestone 3), applied here to the
      // actual task-driving path, not just the read-only detail view.
      const hasLineup = Object.keys(taskState.lineup ?? {}).length > 0;
      if (!hasLineup) continue;
      await this.reattachOne(row.id, taskDir, projectPath, taskState);
    }
  }

  private async reattachOne(taskId: string, taskDir: string, projectPath: string, taskState: TaskState): Promise<void> {
    // Reserved for the whole duration of reattach, including the
    // "waiting for run.finished" branch below -- not just the immediate-
    // start branch. Before this, `isActive()` genuinely read `false`
    // during that whole wait (nothing was in `this.active` yet), so a
    // real API call racing a daemon restart (a resume or a lineup
    // submission for the exact task reattach is mid-way through picking
    // back up) could slip past its own `!isActive()` guard and start a
    // second, concurrent `driveTask()` loop over the same task directory
    // -- the identical race `TaskAlreadyStartingError` closes for
    // `startTask()`, just reached from the reattach path instead. If
    // reservation fails here, something else already claimed this task
    // (vanishingly unlikely this early in daemon startup, but a real,
    // not just theoretical, possibility once a project can be
    // re-registered while other projects' reattach is still running) --
    // skip it rather than fight over it; whatever claimed it first owns
    // driving it now.
    if (!this.reserve(taskId)) return;
    try {
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
      // The reservation above stays held the whole time this waits --
      // released only by start() finally firing, or by the catch below
      // if building fresh params fails.
      const [runName] = stillRunning;
      const onTaskEvent = (tid: string, event: { type: string; run: string | null }): void => {
        if (tid !== taskId || event.type !== "run.finished" || event.run !== runName) return;
        this.watcher.off("task-event", onTaskEvent);
        this.buildParams(taskId, taskDir, projectPath, taskState)
          .then((freshParams) => this.start(taskId, freshParams))
          .catch((err: unknown) => {
            this.reserving.delete(taskId);
            console.error(`task ${taskId}: failed to resume after reattach:`, err);
          });
      };
      this.watcher.on("task-event", onTaskEvent);
    } catch (err) {
      this.reserving.delete(taskId);
      throw err;
    }
  }
}
