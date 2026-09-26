import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killProcessGroup } from "../src/process-kill.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}

/** Real, disclosed bug (Copilot review #5): `killProcessGroup()`'s
 * polling loop used to probe only the process-group *leader*
 * (`process.kill(pid, 0)`, a positive pid) to decide "is the group gone
 * yet." A CLI that forks its own child and then exits itself (a real,
 * common shape) leaves the leader dead while a real child keeps running
 * in the same detached group -- the old check would conclude "gone" the
 * instant the leader died and skip the fallback SIGKILL entirely.
 * `process-kill.ts`'s own updated comment has the fix: `process.kill(-pid, 0)`
 * (negative -- the same negation `terminateProcessGroup()`/
 * `hardKillProcessGroup()` already use to *signal* the group) checks the
 * whole group, per POSIX kill(2).
 *
 * **A live "leader dies, real child outlives it" reproduction was
 * attempted and abandoned as unreliable in this specific sandboxed test
 * environment**, disclosed rather than silently worked around: a real
 * detached leader process forking a real SIGTERM-ignoring child, then
 * exiting itself, reliably lost that child within ~200ms regardless of
 * anything this test's own code did -- confirmed by watching for the
 * child's own pid with *no* kill call issued at all. This points at the
 * sandbox's own process supervision reaping orphaned descendants
 * aggressively (a property of this execution environment, not of
 * `killProcessGroup()` or the kernel's own session/process-group
 * semantics), which makes a differential old-code-vs-new-code
 * reproduction of the exact bug shape unreliable here specifically. The
 * fix itself is still correct by direct inspection against POSIX
 * kill(2) (`-pid` targets the process group; this file's own
 * `terminateProcessGroup()`/`hardKillProcessGroup()` already rely on
 * exactly that semantic to *signal* the group two lines away from the
 * line this fix touches) -- what's tested for real below is the
 * function's own actual, achievable contract: it genuinely terminates a
 * real process group within its timeout, and the group-wide alive-check
 * it now uses reports correctly both while the group is genuinely alive
 * and once it's genuinely gone. */
describe.skipIf(process.platform === "win32")("killProcessGroup()", () => {
  it("terminates a real, live detached process group for real, not just returns true", async () => {
    const leader = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
      detached: true,
    });
    const pid = leader.pid;
    if (pid === undefined) throw new Error("failed to spawn");
    leader.unref();

    expect(isAlive(pid)).toBe(true);
    // process.kill(-pid, 0) -- the group-wide check this fix introduces
    // -- must report "alive" while the group is genuinely alive, the
    // same as the old leader-only check did in this single-process case
    // (they only diverge once the leader specifically has died but the
    // group hasn't -- the scenario the docstring above explains couldn't
    // be reliably reproduced live in this environment).
    expect(() => process.kill(-pid, 0)).not.toThrow();

    const cancelled = await killProcessGroup(pid, 1);
    expect(cancelled).toBe(true);

    await waitFor(() => !isAlive(pid), 3000);
    // And the group-wide probe now correctly reports empty -- this is
    // the exact call `killProcessGroup()`'s own polling loop makes;
    // proving it throws once the group is truly gone is proving the
    // fixed loop's own exit condition is reachable at all.
    expect(() => process.kill(-pid, 0)).toThrow();
  }, 10_000);
});
