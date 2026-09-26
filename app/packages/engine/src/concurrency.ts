import type { Cli } from "@crewbench/adapters";
import { appendEvent } from "./contract-fs.js";

const DEFAULT_MAX_CONCURRENT = 2;

/** Real, disclosed gap Copilot review caught: cancelling a task
 * (`TaskRunner.cancelTask()`) only ever aborted `driveTask()`'s own loop
 * signal -- it never woke a dispatch genuinely blocked *inside* an
 * `await`, specifically a queued `ConcurrencyLimiter.acquire()` call
 * (waiting for a CLI slot) or a pending `ApprovalProvider.request()`
 * call (waiting for a human decision). A task cancelled while queued or
 * awaiting approval stayed `active` forever -- its `driveTask()` promise
 * never settled, so `TaskRunner`'s own `.finally(() => active.delete(...))`
 * never ran, and the route that cancelled it had already returned as if
 * cancellation succeeded. Both `acquire()` and `HttpApprovalProvider.request()`
 * now accept an optional `AbortSignal` and reject with this error the
 * instant it fires, removing their own internal registration (the queue
 * entry / the pending-approval map entry) at the same time -- no stale
 * entry left behind for some later, unrelated `release()`/`resolve()` to
 * silently mis-fire against. `driveTask()`'s own loop (`drive.ts`)
 * catches this one error type around its per-iteration dispatch and
 * persists the same `"stopped"`/`"cancelled by user"` outcome its
 * top-of-loop cancellation check already produces for the simpler
 * between-commands case. */
export class DispatchCancelledError extends Error {
  constructor() {
    super("dispatch cancelled while waiting");
    this.name = "DispatchCancelledError";
  }
}

interface QueuedItem {
  resolve: () => void;
  /** Set only when this waiter was woken by cancellation, not a real
   * `release()` -- lets `acquire()`'s own `finally`-equivalent cleanup
   * (the abort listener) tell the two cases apart without a second flag. */
  reject: (err: Error) => void;
  /** The waiter's own taskDir/run, captured at acquire() time -- the
   * run.dequeued event fired when this waiter is woken must describe
   * *this* run, not whichever run happened to call release(). */
  taskDir: string | undefined;
  run: string | undefined;
}

/** Per-CLI concurrency limiter -- docs/app/phase-1-plan.md's milestone 6:
 * "per-CLI max concurrent runs (default 2, from config), queuing with
 * run.queued/run.dequeued events." A run that can't start immediately
 * waits in FIFO order for that CLI's next free slot; `release()` must be
 * called exactly once per successful `acquire()` (a `using`-less `try {
 * await acquire() } finally { release() }` pattern, since this targets
 * the same Node/TS baseline as the rest of the workspace). */
export class ConcurrencyLimiter {
  private readonly limits: Partial<Record<Cli, number>>;
  private readonly running = new Map<Cli, number>();
  private readonly queue = new Map<Cli, QueuedItem[]>();

  constructor(limits: Partial<Record<Cli, number>> = {}) {
    this.limits = limits;
  }

  private limitFor(cli: Cli): number {
    return this.limits[cli] ?? DEFAULT_MAX_CONCURRENT;
  }

  /** Resolves once a slot for `cli` is free (immediately if under the
   * limit). `taskDir`/`run`, if given, get a `run.queued` event appended
   * when this call actually has to wait -- omit them for a caller that
   * doesn't have a task/run context yet (e.g. a pre-flight check).
   * `signal`, if given and it fires while genuinely queued, removes this
   * waiter's own entry and rejects with `DispatchCancelledError` instead
   * of resolving -- see that error's own docstring for the real bug this
   * closes. A `signal` already aborted before this call even queues
   * rejects immediately, without ever taking a slot or joining the
   * queue. */
  async acquire(cli: Cli, taskDir?: string, run?: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DispatchCancelledError();
    const current = this.running.get(cli) ?? 0;
    if (current < this.limitFor(cli)) {
      this.running.set(cli, current + 1);
      return;
    }
    if (taskDir) {
      await appendEvent(taskDir, "run.queued", { cli }, run ?? null);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const list = this.queue.get(cli) ?? [];
      const onAbort = (): void => {
        const currentList = this.queue.get(cli);
        const idx = currentList?.indexOf(item) ?? -1;
        if (idx >= 0) currentList!.splice(idx, 1);
        item.reject(new DispatchCancelledError());
      };
      const item: QueuedItem = {
        resolve: () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        taskDir,
        run,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      list.push(item);
      this.queue.set(cli, list);
    });
    this.running.set(cli, (this.running.get(cli) ?? 0) + 1);
  }

  /** Releases a slot, waking the next queued waiter for `cli` (if any) --
   * emits `run.dequeued` describing *that waiter's own* taskDir/run
   * (captured when it called `acquire()`), since release() itself has no
   * reason to know or care who is releasing. Must be called exactly once
   * per successful `acquire()`. */
  async release(cli: Cli): Promise<void> {
    const current = this.running.get(cli) ?? 0;
    this.running.set(cli, Math.max(0, current - 1));
    const list = this.queue.get(cli);
    const next = list?.shift();
    if (next) {
      if (next.taskDir) {
        await appendEvent(next.taskDir, "run.dequeued", { cli }, next.run ?? null);
      }
      next.resolve();
    }
  }

  /** Runs `fn` while holding a slot for `cli`, releasing it afterward
   * regardless of success or failure -- the usual way to use this class.
   * If `acquire()` itself rejects (cancelled while queued), `fn` never
   * runs and there's no slot to release -- the rejection propagates
   * straight through. */
  async withSlot<T>(cli: Cli, fn: () => Promise<T>, taskDir?: string, run?: string, signal?: AbortSignal): Promise<T> {
    await this.acquire(cli, taskDir, run, signal);
    try {
      return await fn();
    } finally {
      await this.release(cli);
    }
  }

  runningCount(cli: Cli): number {
    return this.running.get(cli) ?? 0;
  }

  queuedCount(cli: Cli): number {
    return this.queue.get(cli)?.length ?? 0;
  }
}
