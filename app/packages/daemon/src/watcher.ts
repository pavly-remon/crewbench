import { EventEmitter } from "node:events";
import { basename, dirname, join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { listTasks } from "@crewbench/engine";
import type { CrewbenchEvent, RegisteredProject } from "@crewbench/contract";
import { initialTailState, tailNewEvents, type TailState } from "./tail.js";

export interface TaskLocation {
  projectId: string;
  projectPath: string;
  taskDir: string;
}

/** The subset of event types worth surfacing on the global,
 * cross-project board feed (`GET /api/events`) -- per-token/per-tool-call
 * noise (`run.message`/`run.tool_call`/`run.tool_error`) only matters
 * inside a specific agent lane's own per-task stream, not the board.
 * `approval.*` **was** deliberately absent through Phase 3 milestone 4:
 * no such event type was emitted to events.jsonl anywhere in this
 * codebase (Phase 1's approvals were resolved purely in-memory via
 * terminal prompts, never persisted as an event) -- docs/app/
 * phase-2-plan.md's open question 4 proposed including it before Phase 2
 * milestone 2 confirmed it didn't exist yet. Phase 3 milestone 5 (the
 * approvals inbox) is what actually makes it real -- see
 * `packages/engine/src/drive.ts`'s `askApproval()` and
 * `docs/app/contract/events.md`'s entry for both event types. */
const GLOBAL_EVENT_TYPES = new Set<CrewbenchEvent["type"]>([
  "task.created",
  "task.phase_changed",
  "task.round_started",
  "run.started",
  "run.finished",
  // Phase 3 milestone 2's Design decision 7: run.queued/run.dequeued are
  // real, already-emitted event types (packages/engine's
  // ConcurrencyLimiter, wired into dispatchRole() this milestone) --
  // reusing this same allowlist for the board's queue indicator instead
  // of a separate queue-status channel.
  "run.queued",
  "run.dequeued",
  // Phase 3 milestone 5: the actual signal the global inbox (badge
  // count + panel) and desktop notifications react to -- see this
  // file's own docstring above.
  "approval.requested",
  "approval.resolved",
]);

export interface GlobalEvent {
  /** `${taskId}:${seq}` -- unique within one daemon's lifetime, used as
   * the SSE event id for `/api/events`. Unlike the per-task stream, this
   * buffer is in-memory only and does not survive a daemon restart (see
   * this file's `getGlobalEventsSince` docstring). */
  id: string;
  projectId: string;
  taskId: string;
  event: CrewbenchEvent;
}

const GLOBAL_BUFFER_LIMIT = 500;

/** Watches every registered project's `.crewbench/` tree and keeps two
 * things live: a task-id -> project/taskDir index (so
 * `GET /api/tasks/:tid/*` routes can find a bare task id without a
 * project id in the URL, matching the phase prompt's route shapes
 * exactly), and a fan-out of newly appended `events.jsonl` lines to
 * per-task and global subscribers. Emits `"task-event"` with
 * `(taskId, CrewbenchEvent)` and `"global-event"` with `(GlobalEvent)`. */
export class DaemonWatcher extends EventEmitter {
  private readonly fsWatchers = new Map<string, FSWatcher>();
  private readonly taskIndex = new Map<string, TaskLocation>();
  private readonly tailStates = new Map<string, TailState>();
  private readonly globalBuffer: GlobalEvent[] = [];

  resolveTask(taskId: string): TaskLocation | null {
    return this.taskIndex.get(taskId) ?? null;
  }

  /** Phase 3 milestone 3: registers a just-created task immediately,
   * rather than waiting for `addProject()`'s fs watcher to notice
   * `index.json` change on its own (debounced 150ms per
   * `awaitWriteFinish`) -- a client that creates a task and immediately
   * calls `POST .../scoping/messages` must not race that debounce. */
  registerTask(projectId: string, projectPath: string, taskId: string): void {
    this.taskIndex.set(taskId, { projectId, projectPath, taskDir: join(projectPath, ".crewbench", "tasks", taskId) });
  }

  /** Full history for one task's SSE stream, replayed from disk (files
   * stay the source of truth, per docs/app/CONTEXT.md -- this daemon
   * keeps no separate durable event log of its own). `sinceSeq` is
   * exclusive: pass the client's `Last-Event-ID` (or 0 for "everything"
   * on a fresh connection -- deliberate, so a freshly opened agent lane
   * has full history to render immediately, not just events from the
   * moment it happened to connect). */
  async replayTaskEvents(taskId: string, sinceSeq: number): Promise<CrewbenchEvent[]> {
    const location = this.resolveTask(taskId);
    if (!location) return [];
    const path = join(location.taskDir, "events.jsonl");
    const { events } = await tailNewEvents(path, initialTailState());
    return events.filter((e) => e.seq > sinceSeq);
  }

  /** In-memory only -- see `GlobalEvent`'s docstring. A daemon restart
   * (or a client connecting before this daemon has observed anything)
   * legitimately returns an empty replay; the board's initial state
   * comes from `GET /api/projects/:pid/tasks` (Phase 2 milestone 1), not
   * from this buffer. */
  getGlobalEventsSince(lastId: string | null): GlobalEvent[] {
    if (!lastId) return [...this.globalBuffer];
    const idx = this.globalBuffer.findIndex((e) => e.id === lastId);
    return idx === -1 ? [...this.globalBuffer] : this.globalBuffer.slice(idx + 1);
  }

  async addProject(project: RegisteredProject): Promise<void> {
    if (this.fsWatchers.has(project.id)) return;
    await this.rescanProject(project.id, project.path);

    const crewbenchDir = join(project.path, ".crewbench");
    const fsWatcher = watch(crewbenchDir, {
      persistent: true,
      ignoreInitial: true,
      // Debounced (the phase prompt's own word): waits for a file to stop
      // changing for a bit before firing, so a burst of rapid appends to
      // events.jsonl (or index.json's read-modify-write cycle) collapses
      // into one change notification instead of one per write.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 30 },
      ignored: (path: string) => path.includes(join(".crewbench", "wt")) || path.endsWith(".lock") || path.endsWith(".tmp"),
    });
    fsWatcher.on("add", (path: string) => this.onFileChanged(project.id, project.path, path));
    fsWatcher.on("change", (path: string) => this.onFileChanged(project.id, project.path, path));
    this.fsWatchers.set(project.id, fsWatcher);
  }

  async removeProject(projectId: string): Promise<void> {
    const fsWatcher = this.fsWatchers.get(projectId);
    if (fsWatcher) {
      await fsWatcher.close();
      this.fsWatchers.delete(projectId);
    }
    for (const [taskId, location] of this.taskIndex) {
      if (location.projectId === projectId) this.taskIndex.delete(taskId);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.fsWatchers.values()].map((w) => w.close()));
    this.fsWatchers.clear();
  }

  private async onFileChanged(projectId: string, projectPath: string, path: string): Promise<void> {
    const name = basename(path);
    if (name === "index.json" && dirname(path) === join(projectPath, ".crewbench")) {
      await this.rescanProject(projectId, projectPath);
      return;
    }
    if (name === "events.jsonl") {
      const taskDir = dirname(path);
      const taskId = basename(taskDir);
      await this.tailAndEmit(taskId, taskDir, projectId);
    }
  }

  private async rescanProject(projectId: string, projectPath: string): Promise<void> {
    const rows = await listTasks(join(projectPath, ".crewbench"));
    for (const row of rows) {
      this.taskIndex.set(row.id, {
        projectId,
        projectPath,
        taskDir: join(projectPath, ".crewbench", "tasks", row.id),
      });
    }
  }

  private async tailAndEmit(taskId: string, taskDir: string, projectId: string): Promise<void> {
    const eventsPath = join(taskDir, "events.jsonl");
    const state = this.tailStates.get(taskDir) ?? initialTailState();
    const { events, state: nextState } = await tailNewEvents(eventsPath, state);
    this.tailStates.set(taskDir, nextState);
    for (const event of events) {
      this.emit("task-event", taskId, event);
      if (GLOBAL_EVENT_TYPES.has(event.type)) {
        const globalEvent: GlobalEvent = { id: `${taskId}:${event.seq}`, projectId, taskId, event };
        this.globalBuffer.push(globalEvent);
        if (this.globalBuffer.length > GLOBAL_BUFFER_LIMIT) this.globalBuffer.shift();
        this.emit("global-event", globalEvent);
      }
    }
  }
}
