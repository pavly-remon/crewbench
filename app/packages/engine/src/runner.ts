import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childEnv,
  checkArgvSize,
  classifySandboxError,
  createAdapter,
  buildPrompt as buildAdapterPrompt,
  resolveCliPath,
  cliArgvPrefix,
  type CliAdapter,
  type Cli,
  type Effort,
  type Permissions,
} from "@crewbench/adapters";
import { SCHEMA_VERSION, type RoleName } from "@crewbench/contract";
import { appendEvent, atomicWriteJson, lockedReadModifyWrite, nowIso, readJsonOrDefault } from "./contract-fs.js";
import { gitChanges, gitState, type GitState } from "./git.js";
import { killProcessGroup, terminateProcessGroup, hardKillProcessGroup, GRACEFUL_KILL_TIMEOUT_S } from "./process-kill.js";

export interface DispatchParams {
  role: RoleName;
  cli: Cli;
  model: string;
  effort: Effort;
  permissions: Permissions;
  taskDir: string;
  round: number;
  cwd: string;
  handoff: string;
  agentsDir: string;
  schemaPath: string;
  timeoutS?: number;
}

export interface DispatchEnvelope {
  schema_version: number;
  role: RoleName;
  cli: Cli;
  model: string;
  effort: Effort;
  skip_permissions: boolean;
  ok: boolean;
  exit_code: number | null;
  duration_s: number | null;
  result: unknown;
  usage: unknown;
  permission_denials: unknown[];
  error: string | null;
  warnings: string[];
  notes: string[];
  session_id: string | null;
  resume_command: string | null;
  result_file: string;
  log_file: string;
  raw_output_file: string;
}

const DEFAULT_TIMEOUT_S = 1800;

function runName(role: RoleName, round: number): string {
  return `${role}-r${round}`;
}

async function updateStatus(runsDir: string, run: string, fields: Record<string, unknown>): Promise<void> {
  const statusPath = join(runsDir, "status.json");
  const lockPath = join(runsDir, ".status.lock");
  await lockedReadModifyWrite(lockPath, async () => {
    const status = await readJsonOrDefault<Record<string, Record<string, unknown>>>(statusPath, {});
    status[run] = { ...(status[run] ?? {}), ...fields };
    await atomicWriteJson(statusPath, status);
  });
}

/** Runs one role headlessly on one CLI, end to end: builds the prompt,
 * spawns the child detached (its own process group, for group-kill on
 * timeout/cancel), streams its output into `<run>.log` and structured
 * events, captures the envelope, and writes the exact contract file
 * family (`docs/app/contract/README.md`'s "runs/<role>-r<round>.*"
 * section) so a plugin-side `/crewbench:status` can read an app-created
 * task's runs. Ported from crewbench_dispatch.py's main(), collapsed into
 * one direct async call rather than a detached start/wait split -- that
 * split exists in the Python version to work around a host LLM's own
 * shell-tool timeout, which doesn't apply here: this runner *is* the
 * long-running process, not something invoked through a shell tool. */
export async function dispatchRole(params: DispatchParams): Promise<DispatchEnvelope> {
  const { role, cli, model, effort, taskDir, round, cwd, agentsDir, schemaPath } = params;
  const timeoutS = params.timeoutS ?? DEFAULT_TIMEOUT_S;
  const skipPermissions = params.permissions === "skip";
  const run = runName(role, round);
  const runsDir = join(taskDir, "runs");
  await mkdir(runsDir, { recursive: true });

  const outPath = join(runsDir, `${run}.result.json`);
  const rawPath = join(runsDir, `${run}.raw.txt`);
  const logPath = join(runsDir, `${run}.log`);
  const handoffPath = join(runsDir, `${run}.md`);
  const promptPath = join(runsDir, `${run}.prompt.md`);

  await writeFile(handoffPath, params.handoff, "utf-8");

  const envelope: DispatchEnvelope = {
    schema_version: SCHEMA_VERSION,
    role,
    cli,
    model,
    effort,
    skip_permissions: skipPermissions,
    ok: false,
    exit_code: null,
    duration_s: null,
    result: null,
    usage: null,
    permission_denials: [],
    error: null,
    warnings: [],
    notes: [],
    session_id: null,
    resume_command: null,
    result_file: outPath,
    log_file: logPath,
    raw_output_file: rawPath,
  };

  const finish = async (): Promise<DispatchEnvelope> => {
    await writeFile(outPath, JSON.stringify(envelope, null, 2) + "\n", "utf-8");
    await updateStatus(runsDir, run, {
      state: envelope.ok ? "done" : "failed",
      finished_at: nowIso(),
      session_id: envelope.session_id,
      resume_command: envelope.resume_command,
      error: envelope.error,
    });
    await appendEvent(
      taskDir,
      "run.finished",
      { ok: envelope.ok, exit_code: envelope.exit_code, duration_s: envelope.duration_s, error: envelope.error, usage: envelope.usage },
      run,
    );
    return envelope;
  };

  const schema: unknown = JSON.parse(await readFile(schemaPath, "utf-8"));
  const prompt = buildAdapterPrompt(agentsDir, role, cli, params.handoff, schema, skipPermissions);
  await writeFile(promptPath, prompt, "utf-8");

  const cliPath = resolveCliPath(cli);
  if (!cliPath) {
    envelope.error = `${cli} is not installed or not on PATH`;
    return finish();
  }

  const adapter: CliAdapter = createAdapter(cli);
  const tmpDir = await mkdtemp(join(tmpdir(), `crewbench-${run}-`));
  const { argv, stdin, extraOutputFile } = adapter.buildCommand(
    { role, model, effort, skipPermissions, cwd, timeoutS },
    prompt,
    promptPath,
    schemaPath,
    tmpDir,
  );
  // Ported from crewbench_dispatch.py's `cmd[0:1] = cli_argv_prefix(cli_path)`:
  // buildCommand() always emits the bare CLI name as argv[0] (e.g.
  // "claude"); the real launch path -- honoring
  // CREWBENCH_CLI_OVERRIDE_<CLI> and the Windows .py-interpreter
  // workaround -- is substituted in here, after building the command, not
  // inside it.
  argv.splice(0, 1, ...cliArgvPrefix(cliPath));

  try {
    checkArgvSize(argv);
  } catch (err) {
    envelope.error = err instanceof Error ? err.message : String(err);
    return finish();
  }

  const stream = adapter.newStream();
  const env = childEnv(cli, role, taskDirName(taskDir));

  await updateStatus(runsDir, run, {
    schema_version: SCHEMA_VERSION,
    role,
    cli,
    model,
    effort,
    state: "running",
    started_at: nowIso(),
    log_file: logPath,
    session_id: null,
  });
  await appendEvent(taskDir, "run.started", { role, cli, model, effort }, run);

  const gitBefore = await gitState(cwd);
  const start = Date.now();
  const { code, stdout, timedOut } = await spawnAndCollect(argv, {
    cwd,
    env,
    stdin,
    timeoutS,
    onLine: async (entry) => {
      await appendFileLine(logPath, `[${localTime()}] ${entry}\n`);
      const type = classifyEntry(entry);
      await appendEvent(taskDir, type, { text: entry }, run);
    },
    onFeed: (line) => stream.feed(line),
  });
  const durationS = Math.round((Date.now() - start) / 100) / 10;

  await writeFile(rawPath, `$ ${argv[0]} ...\n--- stdout ---\n${stdout}\n--- stderr ---\n\n`, "utf-8");

  envelope.duration_s = durationS;
  envelope.exit_code = code;
  envelope.session_id = stream.sessionId;
  envelope.resume_command = adapter.resumeCommand(stream.sessionId);
  envelope.usage = adapter.extractUsage(stream, stdout, durationS, extraOutputFile);

  const { result, denials, error: parseError } = adapter.parseOutput(stream, stdout, extraOutputFile);
  envelope.result = result;
  envelope.permission_denials = denials;

  const gitAfter = await gitState(cwd);
  const { warnings: gitWarnings, notes: gitNotes } = gitChanges(role, gitBefore, gitAfter);
  envelope.warnings.push(...gitWarnings);
  envelope.notes.push(...gitNotes);
  for (const warning of gitWarnings) {
    await appendEvent(taskDir, "git.warning", { warning }, run);
  }

  let problem = parseError;
  if (problem === null && code !== 0 && code !== null) {
    problem = `${cli} exited with code ${String(code)}`;
  }
  if (timedOut) {
    const timeoutMsg = `timed out after ${timeoutS}s`;
    problem = problem === null ? timeoutMsg : `${timeoutMsg} (${problem})`;
  }
  if (problem) {
    const hint = classifySandboxError(problem);
    problem = hint ? `${hint}: ${problem}` : problem;
  }
  envelope.error = problem;
  envelope.ok = problem === null;

  return finish();
}

function taskDirName(taskDir: string): string {
  const normalized = taskDir.replace(/[/\\]+$/, "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] ?? normalized;
}

function localTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

async function appendFileLine(path: string, line: string): Promise<void> {
  await appendFile(path, line, "utf-8");
}

type LogEntryType = "run.message" | "run.tool_call" | "run.tool_error";
function classifyEntry(entry: string): LogEntryType {
  if (entry.startsWith("  error:")) return "run.tool_error";
  if (entry.startsWith("tool: ")) return entry.includes(" -> ") ? "run.tool_error" : "run.tool_call";
  return "run.message";
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

async function spawnAndCollect(
  argv: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    stdin: string | null;
    timeoutS: number;
    onLine: (entry: string) => Promise<void>;
    onFeed: (line: string) => string[];
  },
): Promise<SpawnResult> {
  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: [opts.stdin !== null ? "pipe" : "ignore", "pipe", "pipe"],
  });

  if (opts.stdin !== null && child.stdin) {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  }

  let stdoutAll = "";
  let buffer = "";
  const feedQueue: Promise<void>[] = [];

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stdoutAll += text;
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const entries = opts.onFeed(rawLine + "\n");
      for (const entry of entries) {
        feedQueue.push(opts.onLine(entry));
      }
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", (chunk: Buffer) => {
    stdoutAll += chunk.toString("utf-8");
  });

  let timedOut = false;
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        terminateProcessGroup(child.pid);
        const hardTimer = setTimeout(() => {
          if (child.pid) hardKillProcessGroup(child.pid);
        }, GRACEFUL_KILL_TIMEOUT_S * 1000);
        child.once("exit", () => clearTimeout(hardTimer));
      }
    }, opts.timeoutS * 1000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (buffer.trim()) {
    const entries = opts.onFeed(buffer);
    for (const entry of entries) feedQueue.push(opts.onLine(entry));
  }
  await Promise.all(feedQueue);

  return { code, stdout: stdoutAll, timedOut };
}

/** Runs tester and code-reviewer against the same round's diff, in
 * parallel -- one `wait`, not two, mirroring lib/dispatch.md §4 point 4
 * ("start both ... before your first wait call"). */
export async function dispatchVerification(
  testerParams: DispatchParams,
  reviewerParams: DispatchParams,
): Promise<{ tester: DispatchEnvelope; reviewer: DispatchEnvelope }> {
  const [tester, reviewer] = await Promise.all([dispatchRole(testerParams), dispatchRole(reviewerParams)]);
  return { tester, reviewer };
}

/** Cancel a run: kills its whole process group and marks it `failed` in
 * status.json. Ported from crewbench_dispatch.py's cmd_cancel(). Needs the
 * pid recorded in status.json (updateStatus() would have to record `pid`
 * for a caller to use this -- see docs/app/phase-1-plan.md's milestone 4
 * note: this runner doesn't yet expose a live pid to callers before the
 * process exits, since dispatchRole() is a single awaited call rather than
 * a separately-started handle. A pid-exposing "start" split, if needed for
 * real interactive cancellation, is a follow-up, not silently assumed
 * done here.) */
export async function cancelRun(taskDir: string, run: string): Promise<{ cancelled: boolean }> {
  const runsDir = join(taskDir, "runs");
  const status = await readJsonOrDefault<Record<string, Record<string, unknown>>>(join(runsDir, "status.json"), {});
  const entry = status[run] ?? {};
  let cancelledAny = false;
  for (const key of ["pid", "launcher_pid"]) {
    const pid = entry[key];
    if (typeof pid === "number") {
      cancelledAny = (await killProcessGroup(pid)) || cancelledAny;
    }
  }
  await updateStatus(runsDir, run, { state: "failed", error: "cancelled by user", finished_at: nowIso() });
  return { cancelled: cancelledAny };
}
