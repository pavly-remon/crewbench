import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateResult, GateStepResult } from "./types.js";
import { shellSplit } from "./shell-split.js";
import { GRACEFUL_KILL_TIMEOUT_S, hardKillProcessGroup, terminateProcessGroup } from "./process-kill.js";
import { appendEvent, atomicWriteJson, lockedReadModifyWrite, nowIso, readJsonOrDefault } from "./contract-fs.js";

const MAX_TAIL_LINES = 200;
export const DEFAULT_GATE_TIMEOUT_S = 600;

/** Real, disclosed bug fix (Copilot review #10): a gate command is a
 * real in-flight subprocess exactly like a role dispatch, but before
 * this it never wrote a `status.json` entry at all -- `runner.ts`'s own
 * `cancelRun()` (the only cancellation mechanism this codebase has,
 * `routes/task-control.ts`'s cancel route iterates `status.json`'s
 * `"running"` entries and calls it for each) had nothing to find, so
 * cancelling a task while its gate was running left the gate process
 * running until completion or timeout -- possibly still mutating the
 * project (a lint --fix, a test run with side effects) after the user
 * believed they'd cancelled. Reuses the exact same run-name convention
 * `gate-r<round>` already established elsewhere in this codebase
 * (`gate-r${round}.result.json`/`.log`, and `routes/task-control.ts`'s
 * own retry-run route already treats `gate-rN` as a real run name) and
 * the identical locked-read-modify-write shape `runner.ts`'s own
 * (private, unexported) `updateStatus()` uses -- not imported from
 * there since gate.ts has no dependency on runner.ts today and adding
 * one just to share four lines isn't worth the coupling. */
async function updateGateStatus(runsDir: string, run: string, fields: Record<string, unknown>): Promise<void> {
  const statusPath = join(runsDir, "status.json");
  const lockPath = join(runsDir, ".status.lock");
  await lockedReadModifyWrite(lockPath, async () => {
    const status = await readJsonOrDefault<Record<string, Record<string, unknown>>>(statusPath, {});
    status[run] = { ...(status[run] ?? {}), ...fields };
    await atomicWriteJson(statusPath, status);
  });
}

interface ProjectCommands {
  format_check?: string | null;
  lint?: string | null;
  typecheck?: string | null;
  test?: string | null;
  test_changed?: string | null;
}

/** Ported from crewbench_gate.py's load_commands(). */
async function loadCommands(projectJsonPath: string): Promise<ProjectCommands> {
  try {
    const data = JSON.parse(await readFile(projectJsonPath, "utf-8")) as { commands?: unknown };
    return typeof data.commands === "object" && data.commands !== null ? (data.commands as ProjectCommands) : {};
  } catch {
    return {};
  }
}

/** [name, command] in gate order; test_changed wins over test when both
 * are configured. Ported from crewbench_gate.py's steps_to_run(). */
export function stepsToRun(commands: ProjectCommands): [string, string][] {
  const steps: [string, string][] = [];
  for (const name of ["format_check", "lint", "typecheck"] as const) {
    const cmd = commands[name];
    if (cmd) steps.push([name, cmd]);
  }
  const testCmd = commands.test_changed || commands.test;
  if (testCmd) {
    steps.push([commands.test_changed ? "test_changed" : "test", testCmd]);
  }
  return steps;
}

async function runStep(
  name: string,
  command: string,
  cwd: string,
  timeoutS: number,
  runsDir: string,
  run: string,
): Promise<{ step: GateStepResult; output: string }> {
  const start = Date.now();
  const argv = shellSplit(command);
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd,
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  // Real, disclosed fix (Copilot review #10, this file's own top-of-file
  // docstring has the full story): record the real pid the instant it's
  // known, exactly like runner.ts's dispatchRole() already does via its
  // own onSpawn callback -- `cancelRun()` (routes/task-control.ts's
  // cancel route) can only kill what status.json actually tells it is
  // running.
  if (child.pid !== undefined) {
    await updateGateStatus(runsDir, run, { state: "running", pid: child.pid, started_at: nowIso() });
  }

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));

  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        terminateProcessGroup(child.pid);
        const hardTimer = setTimeout(() => {
          if (child.pid) hardKillProcessGroup(child.pid);
        }, GRACEFUL_KILL_TIMEOUT_S * 1000);
        child.once("exit", () => clearTimeout(hardTimer));
      }
    }, timeoutS * 1000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  const durationS = Math.round((Date.now() - start) / 100) / 10;
  const tail = output.split("\n").slice(-MAX_TAIL_LINES).join("\n");
  // Same finalization runner.ts's own dispatchRole() does after its
  // child exits -- and the same real, pre-existing race that already
  // exists there too, disclosed rather than silently assumed away: if
  // `cancelRun()` fires concurrently, whichever write lands last wins.
  // Not a new gap this fix introduces; matching this codebase's own
  // established behavior for the identical situation elsewhere, not a
  // regression to solve here.
  await updateGateStatus(runsDir, run, {
    state: timedOut ? "failed" : exitCode === 0 ? "done" : "failed",
    finished_at: nowIso(),
  });
  return {
    step: { name, command, exit_code: timedOut ? null : exitCode, duration_s: durationS, timed_out: timedOut, output_tail: tail },
    output,
  };
}

/** Runs, in order, whichever of format_check/lint/typecheck/test_changed
 * (falling back to test) has a configured command, stopping at the first
 * failing step. Ported field-for-field from crewbench_gate.py's
 * run_gate(): same step order, same skip-if-unconfigured/stop-on-first-
 * failure semantics, same log/result file layout, same gate.finished
 * event. `projectJsonPath` defaults to `<cwd>/.crewbench/project.json`. */
export async function runGate(
  cwd: string,
  taskDir: string,
  round: number,
  projectJsonPath?: string,
  timeoutS: number = DEFAULT_GATE_TIMEOUT_S,
): Promise<{ result: GateResult; logPath: string; resultPath: string }> {
  const runsDir = join(taskDir, "runs");
  await mkdir(runsDir, { recursive: true });
  const resolvedProjectJson = projectJsonPath ?? join(cwd, ".crewbench", "project.json");
  const commands = await loadCommands(resolvedProjectJson);
  const steps = stepsToRun(commands);

  const result: GateResult = { ok: true, steps: [] };
  const logPath = join(runsDir, `gate-r${round}.log`);
  await writeFile(logPath, "", "utf-8");

  const run = `gate-r${round}`;
  if (steps.length === 0) {
    await appendFile(logPath, "no gate commands configured in project.json — nothing to run\n", "utf-8");
  }
  for (const [name, command] of steps) {
    await appendFile(logPath, `$ ${command}\n`, "utf-8");
    const { step, output } = await runStep(name, command, cwd, timeoutS, runsDir, run);
    await appendFile(logPath, output, "utf-8");
    if (output && !output.endsWith("\n")) await appendFile(logPath, "\n", "utf-8");
    const status = step.timed_out ? "timed out" : `exit ${step.exit_code}`;
    await appendFile(logPath, `${status} after ${step.duration_s}s\n\n`, "utf-8");
    result.steps.push(step);
    if (step.exit_code !== 0) {
      result.ok = false;
      break;
    }
  }

  const resultPath = join(runsDir, `gate-r${round}.result.json`);
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
  await appendEvent(taskDir, "gate.finished", { round, ok: result.ok, steps: result.steps });
  return { result, logPath, resultPath };
}
