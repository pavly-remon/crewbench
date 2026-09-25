import { readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { appendField, atomicWriteJson, cancelRun, loadState, readJsonOrDefault, setField } from "@crewbench/engine";
import { ApiCancelTaskRequestSchema, ApiRetryRunRequestSchema, ApiTaskDetailSchema } from "@crewbench/contract";
import type { DaemonWatcher } from "../watcher.js";
import { TaskAlreadyStartingError, type TaskRunner } from "../task-runner.js";
import { buildTaskDetail } from "../task-detail.js";

interface StatusEntry {
  state?: string;
  [key: string]: unknown;
}

/** `POST /api/tasks/:tid/{cancel,resume,retry-run}` (Phase 3 milestone
 * 6). Every route here 404s for an unknown task and 403s for a
 * `"plugin"`-owned one (`TaskRunner` never drives one, Design decision
 * 5 -- there is nothing here for it to cancel/resume/retry). */
export function registerTaskControlRoutes(app: FastifyInstance, watcher: DaemonWatcher, taskRunner: TaskRunner): void {
  /** Cancels a task: always stops its `driveTask()` loop from starting
   * anything further (`TaskRunner.cancelTask()`), and kills whatever
   * subprocess(es) are genuinely in flight right now via the engine's
   * real `cancelRun()` (built Phase 1 milestone 6, made functional by
   * Phase 3 milestone 1's pid-recording fix) -- `body.run` if given,
   * otherwise every run `runs/status.json` currently marks `"running"`
   * (there can genuinely be two: `dispatch_verification` always
   * dispatches tester and code-reviewer together, `runner.ts`). If this
   * daemon process isn't actually driving the task right now (`!active`
   * -- no live loop for `cancelSignal` to reach, e.g. the task was
   * already idle for some other reason), the phase is written directly
   * here instead, since nothing else will. */
  app.post<{ Params: { tid: string }; Body: unknown }>("/api/tasks/:tid/cancel", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const state = await loadState(location.taskDir);
    if (state.owner !== "app") {
      await reply.code(403).send({ error: `task ${state.id} is not owned by the app -- it can't be cancelled from here` });
      return;
    }
    const parsed = ApiCancelTaskRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }

    // Real race, found live: signal the loop to stop *before* touching
    // any subprocess, not after. `cancelTask()` is synchronous
    // (`AbortController.abort()`) and returns instantly; `cancelRun()`
    // below sends SIGTERM and then polls every 200ms for the process to
    // actually die (`killProcessGroup()`) -- easily enough time for the
    // in-flight `dispatchRole()` call it's killing to resolve and for
    // `driveTask()`'s loop to race straight past its own
    // `cancelSignal.aborted` check into dispatching the *next* command
    // (gate, then verification) before this route ever got around to
    // setting the signal. Calling `cancelTask()` first closes that
    // window: the signal is set before the kill even sends its first
    // SIGTERM, so no matter how fast the subprocess dies, the loop's
    // next iteration already sees it aborted.
    const wasActive = taskRunner.cancelTask(state.id);

    const statusPath = join(location.taskDir, "runs", "status.json");
    const status = await readJsonOrDefault<Record<string, StatusEntry>>(statusPath, {});
    const targets = parsed.data.run
      ? [parsed.data.run]
      : Object.entries(status)
          .filter(([, info]) => info.state === "running")
          .map(([run]) => run);
    for (const run of targets) {
      await cancelRun(location.taskDir, run);
    }

    if (!wasActive) {
      await setField(location.taskDir, "phase", "stopped");
    }
    await appendField(location.taskDir, "notes", "Cancelled by user.");

    const detail = await buildTaskDetail(location, taskRunner);
    await reply.send(ApiTaskDetailSchema.parse(detail));
  });

  /** Un-pauses a task sitting in a terminal `"stopped"`/`"failed"` phase
   * -- **not** the same thing `reattachProject()` already does
   * automatically on every daemon restart. That reattach deliberately
   * skips any task in a terminal phase (`["done","stopped","failed"]`,
   * `task-runner.ts`'s own `reattachProject()` loop) -- a `"stopped"`
   * task is, by the engine's own rules, *supposed* to stay stopped
   * (max rounds reached, stuck detection, a declined commit, or now, a
   * user's own cancel) until a person deliberately says otherwise. This
   * route is that deliberate signal: it rebuilds fresh `DriveTaskParams`
   * from disk exactly as `startTask()`/reattach already do
   * (`buildParams()` -> `rehydrateState()`) and restarts `driveTask()`.
   *
   * **What "resume" concretely undoes, and what it doesn't**:
   * `rehydrateState()` rebuilds phase/round purely by replaying
   * `runs/*.result.json` files (`resume.ts`) -- it never reads
   * `state.json`'s own `phase` field, so a cancel's `setField(...,
   * "phase", "stopped")` (this file's own `cancel` route, or the
   * loop's own cancellation check in `drive.ts`) doesn't corrupt
   * anything replay depends on; resuming a cancelled task genuinely
   * continues from wherever its last real file-backed round left off.
   * But resuming a task stopped for a *file-backed* reason (e.g. "gate
   * still failing after max rounds") replays into that exact same
   * stopped conclusion again, since nothing on disk changed -- resuming
   * one of those alone is a real no-op by design, not a bug; pairing it
   * with `retry-run` first (which does change what's on disk) is what
   * actually unsticks that case. Disclosed here rather than silently
   * only half-solving "resume." */
  app.post<{ Params: { tid: string } }>("/api/tasks/:tid/resume", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const state = await loadState(location.taskDir);
    if (state.owner !== "app") {
      await reply.code(403).send({ error: `task ${state.id} is not owned by the app -- it can't be resumed from here` });
      return;
    }
    if (taskRunner.isActive(state.id)) {
      await reply.code(400).send({ error: `task ${state.id} is already running -- nothing to resume` });
      return;
    }
    if (state.phase !== "stopped" && state.phase !== "failed") {
      await reply.code(400).send({ error: `task ${state.id} is in phase "${state.phase}" -- only a stopped or failed task can be resumed` });
      return;
    }

    await appendField(location.taskDir, "notes", "Resumed by user.");
    try {
      await taskRunner.startTask(state.id, location.taskDir, location.projectPath, state);
    } catch (err) {
      // Real, disclosed race caught by review: this route's own
      // `isActive()` check above and the actual `startTask()` call
      // aren't atomic with each other, so two concurrent resume
      // requests can both pass the check above before either reserves.
      // `TaskRunner`'s own synchronous reservation (`TaskAlreadyStartingError`'s
      // docstring has the full story) is what actually stops the loser
      // from starting a second `driveTask()` loop -- this just reports
      // that loss as a real 409, not an unhandled 500.
      if (err instanceof TaskAlreadyStartingError) {
        await reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }

    const detail = await buildTaskDetail(location, taskRunner);
    await reply.send(ApiTaskDetailSchema.parse(detail));
  });

  /** Retries one run of the task's *current* round -- confirmed open
   * question 2: re-dispatches exactly that one run with the same
   * parameters that produced it, then re-enters the normal
   * `decide()`/`reduce()` loop from wherever that leaves the engine
   * state. Implemented by clearing that run's own `.result.json` (and
   * every later step *in the same round*, since their old results no
   * longer correspond to fresh work -- see below) and letting the
   * existing replay-from-files architecture (`rehydrateState()`) do the
   * rest: with the target files gone, replay naturally stops exactly at
   * the point decide() would ask for them again, so restarting
   * `driveTask()` re-dispatches that step for real, through the same
   * code path every other dispatch uses, with no bespoke one-off
   * dispatch call needed here at all.
   *
   * **Pipeline order, and what gets cleared alongside the named run**:
   * `developer` < `gate` < `tester`/`code-reviewer` (the last two always
   * dispatched together, `dispatch_verification` -- retrying either
   * retries both; there is no code path that dispatches just one of
   * them alone, so pretending otherwise here would be fake, not real,
   * granularity). Retrying `developer-rN` clears `gate-rN`/`tester-rN`/
   * `code-reviewer-rN` too (their results were produced against the old
   * developer output); retrying `gate-rN` clears `tester-rN`/
   * `code-reviewer-rN` but leaves `developer-rN` alone; retrying
   * `tester-rN` or `code-reviewer-rN` clears both of them, leaving
   * `developer-rN`/`gate-rN` alone.
   *
   * **Scoped to the task's current round only, and to app-owned tasks
   * only**: `run` must name `state.round`'s own round number --
   * `rehydrateState()`'s replay stops at the *first* round missing a
   * developer result, so clearing an *earlier* round's files would
   * silently discard replay of every round after it too (their files
   * would still exist on disk, just unreached by decide()/reduce() until
   * the loop plods back forward through them again) -- confusing,
   * expensive, and not what "retry" should mean. Rejected outright
   * rather than allowed with a surprising cost. `ui-ux` (the one-time
   * design dispatch, not part of any round) isn't a supported `run`
   * shape at all -- `ApiRetryRunRequestSchema`'s own regex already
   * excludes it. */
  app.post<{ Params: { tid: string }; Body: unknown }>("/api/tasks/:tid/retry-run", async (request, reply) => {
    const location = watcher.resolveTask(request.params.tid);
    if (!location) {
      await reply.code(404).send({ error: `no such task: ${request.params.tid}` });
      return;
    }
    const state = await loadState(location.taskDir);
    if (state.owner !== "app") {
      await reply.code(403).send({ error: `task ${state.id} is not owned by the app -- it can't be retried from here` });
      return;
    }
    if (taskRunner.isActive(state.id)) {
      await reply.code(400).send({ error: `task ${state.id} is already running -- stop it before retrying a run` });
      return;
    }
    const parsed = ApiRetryRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: parsed.error.message });
      return;
    }
    const match = parsed.data.run.match(/^(developer|gate|tester|code-reviewer)-r(\d+)$/);
    if (!match) {
      await reply.code(400).send({ error: `malformed run: ${parsed.data.run}` });
      return;
    }
    const role = match[1] as "developer" | "gate" | "tester" | "code-reviewer";
    const round = Number(match[2]);

    const runsDir = join(location.taskDir, "runs");
    const files = existsSync(runsDir) ? await readdir(runsDir) : [];
    const maxDeveloperRound = files
      .map((f) => /^developer-r(\d+)\.result\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .reduce((max, n) => Math.max(max, n), 0);
    if (round !== maxDeveloperRound) {
      await reply
        .code(400)
        .send({ error: `only the current round (${maxDeveloperRound}) can be retried -- ${parsed.data.run} is an earlier round` });
      return;
    }

    const PIPELINE_RANK: Record<string, number> = { developer: 0, gate: 1, tester: 2, "code-reviewer": 2 };
    const rank = PIPELINE_RANK[role] as number;
    const toClear = (["developer", "gate", "tester", "code-reviewer"] as const).filter((r) => (PIPELINE_RANK[r] as number) >= rank);

    const status = await readJsonOrDefault<Record<string, StatusEntry>>(join(runsDir, "status.json"), {});
    for (const r of toClear) {
      const name = `${r}-r${round}`;
      const resultPath = join(runsDir, `${name}.result.json`);
      const logPath = join(runsDir, `${name}.log`);
      if (existsSync(resultPath)) await rm(resultPath);
      if (existsSync(logPath)) await rm(logPath);
      delete status[name];
    }
    await atomicWriteJson(join(runsDir, "status.json"), status);
    await appendField(location.taskDir, "notes", `Retrying ${parsed.data.run}.`);

    const freshState = await loadState(location.taskDir);
    try {
      await taskRunner.startTask(state.id, location.taskDir, location.projectPath, freshState);
    } catch (err) {
      // Same real, disclosed race as the resume route above -- this
      // route's own `isActive()` check isn't atomic with `startTask()`
      // either.
      if (err instanceof TaskAlreadyStartingError) {
        await reply.code(409).send({ error: err.message });
        return;
      }
      throw err;
    }

    const detail = await buildTaskDetail(location, taskRunner);
    await reply.send(ApiTaskDetailSchema.parse(detail));
  });
}
