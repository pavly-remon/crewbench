import type { Cli } from "@crewbench/adapters";
import { appendEvent } from "./contract-fs.js";

const DEFAULT_MAX_CONCURRENT = 2;

interface QueuedItem {
  resolve: () => void;
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
   * doesn't have a task/run context yet (e.g. a pre-flight check). */
  async acquire(cli: Cli, taskDir?: string, run?: string): Promise<void> {
    const current = this.running.get(cli) ?? 0;
    if (current < this.limitFor(cli)) {
      this.running.set(cli, current + 1);
      return;
    }
    if (taskDir) {
      await appendEvent(taskDir, "run.queued", { cli }, run ?? null);
    }
    await new Promise<void>((resolve) => {
      const list = this.queue.get(cli) ?? [];
      list.push({ resolve, taskDir, run });
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
   * regardless of success or failure -- the usual way to use this class. */
  async withSlot<T>(cli: Cli, fn: () => Promise<T>, taskDir?: string, run?: string): Promise<T> {
    await this.acquire(cli, taskDir, run);
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
