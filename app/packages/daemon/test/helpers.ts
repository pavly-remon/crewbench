import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function gitRepo(prefix = "crewbench-daemon-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "hello\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

/** Polls the per-task SSE route until the watcher's task index knows
 * about `taskId` (a plain 200 vs. the "unknown task" 404), instead of a
 * fixed sleep -- proved necessary in Phase 2 milestone 2's tests (a fixed
 * sleep was flaky under `pnpm -r test`'s parallel cross-package CPU
 * load); shared here so milestone 4's tests don't reintroduce the same
 * flat-sleep flakiness. Each probe opens and immediately cancels the
 * stream -- only the response status matters. */
export async function waitForTaskKnown(
  baseUrl: string,
  token: string,
  taskId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/events`, { headers: { Authorization: `Bearer ${token}` } });
    res.body?.cancel().catch(() => {});
    if (res.status !== 404) return;
    if (Date.now() > deadline) throw new Error(`watcher never learned about task ${taskId} within ${timeoutMs}ms`);
    await sleep(100);
  }
}
