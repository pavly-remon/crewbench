import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdapter, type Cli } from "@crewbench/adapters";
import {
  baseCommit,
  branchName,
  copyWorkspaceFiles,
  createTask,
  createWorktree,
  detectProfile,
  driveTask,
  initialState,
  isDirty,
  makeTaskId,
  reduce,
  runSetupCommands,
  setField,
  startScoping,
  continueScoping,
  worktreePath as computeWorktreePath,
  type FullEngineState,
} from "@crewbench/engine";
import type { Project } from "@crewbench/contract";
import { extractJiraKey, parseRunFlags } from "../flags.js";
import { resolveLineup, type ResolvedLineup } from "../lineup.js";
import { agentsDir, defaultsPath, schemaPath } from "../root.js";
import { ask, confirm } from "../prompt.js";
import { createTerminalApprovalProvider } from "../terminal-approvals.js";

const LEAD_PREFERENCE: Cli[] = ["claude", "codex", "agy", "copilot"];

async function pickLeadCli(): Promise<Cli> {
  for (const cli of LEAD_PREFERENCE) {
    const report = await createAdapter(cli).doctor();
    if (report.installed) return cli;
  }
  throw new Error("no crewbench-supported CLI (claude, codex, agy, copilot) was found on PATH");
}

async function ensureProfile(projectRoot: string): Promise<Project> {
  const profilePath = join(projectRoot, ".crewbench", "project.json");
  if (existsSync(profilePath)) {
    return JSON.parse(await readFile(profilePath, "utf-8")) as Project;
  }
  const detected = await detectProfile(projectRoot);
  console.log("No .crewbench/project.json yet. Detected:");
  console.log(JSON.stringify(detected, null, 2));
  const yes = await confirm("Save this as the project profile?", true);
  const profile: Project = { ...detected, confirmed: yes, detected_at: new Date().toISOString() };
  await mkdir(join(projectRoot, ".crewbench"), { recursive: true });
  await writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n", "utf-8");
  return profile;
}

function printLineup(lineup: ResolvedLineup): void {
  console.log("\nLineup:");
  for (const [role, r] of Object.entries(lineup.roles)) {
    console.log(`  ${role.padEnd(14)} ${r.cli.padEnd(8)} ${r.model.padEnd(24)} effort=${r.effort} permissions=${r.permissions}`);
  }
  console.log(`  loop: max_rounds=${lineup.loop.maxRounds} fix_threshold=${lineup.loop.fixThreshold}`);
  console.log(`  workspace: mode=${lineup.workspace.mode}\n`);
}

export async function runCommand(argv: string[], root: string): Promise<void> {
  const flags = parseRunFlags(argv);
  const { jiraKey, rest: taskText } = extractJiraKey(flags.taskText);
  if (!taskText) throw new Error('usage: crewbench run "<task description>" [flags]');

  const projectRoot = process.cwd();
  const leadCli = await pickLeadCli();
  console.log(`Lead CLI: ${leadCli}`);

  await ensureProfile(projectRoot);

  const lineup = await resolveLineup(defaultsPath(root), projectRoot, leadCli, {
    dev: flags.dev ?? undefined,
    review: flags.review ?? undefined,
    rounds: flags.rounds ?? undefined,
  });
  printLineup(lineup);
  if (lineup.confirmLineup !== "never" && !flags.yes) {
    const ok = await confirm("Proceed with this lineup?", true);
    if (!ok) {
      console.log("Stopped before delegating anything.");
      return;
    }
  }

  // --- Scoping ---
  const leadModel = lineup.roles.developer.model; // the lead has no dedicated lineup slot -- see open question 2's resolution
  let scoping = await startScoping(leadCli, leadModel, "medium", taskText, projectRoot, jiraKey);
  while (scoping.ok && !scoping.spec) {
    if (flags.yes) break; // non-interactive: proceed with whatever the lead has, rather than block forever
    const answer = await ask(`${scoping.reply}\n> `);
    scoping = await continueScoping(leadCli, leadModel, "medium", answer, scoping.sessionId as string, projectRoot);
  }
  const spec = scoping.spec;
  const title = spec?.title ?? taskText.slice(0, 60);

  const needsDesign = flags.design || (flags.yes ? false : await confirm("Use the ui-ux role for this task?", false));

  // --- Task creation ---
  const taskId = makeTaskId(taskText);
  const taskDir = join(projectRoot, ".crewbench", "tasks", taskId);
  await createTask(taskDir, { id: taskId, command: "new-task", title, jiraKey });
  if (spec) {
    const specPath = join(taskDir, "spec.json");
    await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", "utf-8");
    await setField(taskDir, "spec_file", specPath);
  }
  await setField(taskDir, "lineup", lineup.roles);

  // --- Worktree pre-flight ---
  const base = await baseCommit(projectRoot);
  await setField(taskDir, "base_commit", base);
  let cwd = projectRoot;
  let branch: string | null = null;
  let worktree: string | null = null;

  if (lineup.workspace.mode === "worktree") {
    if (await isDirty(projectRoot)) {
      console.log("The main tree has uncommitted changes.");
      const proceed = flags.yes || (await confirm("Continue anyway? (the worktree starts from HEAD and won't include them)", false));
      if (!proceed) {
        console.log("Stopped. Commit/stash your changes, or rerun with --in-place.");
        return;
      }
    }
    branch = branchName(taskId, jiraKey);
    worktree = computeWorktreePath(projectRoot, taskId, jiraKey);
    await createWorktree(projectRoot, worktree, branch, base);
    await setField(taskDir, "branch", branch);
    await setField(taskDir, "worktree", worktree);
    if (lineup.workspace.setup.length > 0) {
      await runSetupCommands(worktree, lineup.workspace.setup);
    }
    if (lineup.workspace.copy.length > 0 && (flags.yes ? false : await confirm(`Copy ${lineup.workspace.copy.join(", ")} into the worktree?`, false))) {
      await copyWorkspaceFiles(projectRoot, worktree, lineup.workspace.copy);
    }
    cwd = worktree;
  }

  const state: FullEngineState = reduce(initialState(), { type: "start", needsDesign, loop: lineup.loop });

  await driveTask({
    state,
    taskDir,
    cwd,
    lineup,
    agentsDir: agentsDir(root),
    schemaPathFor: (role) => schemaPath(root, role),
    taskText,
    spec,
    title,
    projectRoot,
    base,
    branch,
    worktree,
    approvals: createTerminalApprovalProvider(),
    yes: flags.yes,
  });
}
