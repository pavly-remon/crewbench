import { execFileSync } from "node:child_process";

/** Seconds between SIGTERM and SIGKILL for a run's process group. Ported
 * from crewbench_dispatch.py's GRACEFUL_KILL_TIMEOUT. */
export const GRACEFUL_KILL_TIMEOUT_S = 10;

/** Send the initial terminate signal to pid's whole process group/tree
 * (POSIX SIGTERM to the group, since child_process.spawn(..., {detached:
 * true}) makes the child its own process-group leader; Windows
 * `taskkill /T /F`, which is already a hard kill). Returns false if there
 * was nothing there to signal. Ported from
 * crewbench_dispatch.py's _terminate_pid_group(). */
export function terminateProcessGroup(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // best-effort -- the process may already be gone
    }
    return true;
  }
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Ported from crewbench_dispatch.py's _hard_kill_pid_group(). */
export function hardKillProcessGroup(pid: number): void {
  if (process.platform === "win32") return; // the taskkill /F above was already the hard kill
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Kill pid's whole process group/tree from outside -- used when there's
 * no live child_process handle to await exit on, so it polls for the
 * group to disappear instead. Ported from
 * crewbench_dispatch.py's kill_pid_group(). */
export async function killProcessGroup(pid: number, timeoutS = GRACEFUL_KILL_TIMEOUT_S): Promise<boolean> {
  if (!terminateProcessGroup(pid)) return false;
  if (process.platform === "win32") return true;
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    try {
      // Real, disclosed bug caught by review: `process.kill(pid, 0)`
      // (a positive pid) only probes the group *leader* -- a CLI that
      // spawns its own children and then exits itself (a real, common
      // shape: a wrapper script that forks a real worker) leaves this
      // loop concluding "gone" the instant the leader dies, skipping the
      // fallback SIGKILL below entirely while a real child keeps
      // running in the same detached group. `process.kill(-pid, 0)`
      // (negative -- the same negation `terminateProcessGroup()` and
      // `hardKillProcessGroup()` already use to *signal* the group, per
      // POSIX kill(2): a negative pid targets the whole process group)
      // instead throws ESRCH only once every process in the group is
      // actually gone, not just the leader.
      process.kill(-pid, 0); // signal 0: alive-check, doesn't actually signal
    } catch {
      return true; // the whole group is gone, not just the leader
    }
    await sleep(200);
  }
  hardKillProcessGroup(pid);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
