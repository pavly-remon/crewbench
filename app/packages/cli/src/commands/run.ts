import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdapter, type Cli } from "@crewbench/adapters";
import {
  baseCommit,
  branchName,
  commitAll,
  copyWorkspaceFiles,
  createTask,
  createWorktree,
  decide,
  detectProfile,
  diffStat,
  dispatchRole,
  dispatchVerification,
  initialState,
  integrate,
  isDirty,
  makeTaskId,
  reduce,
  removeWorktree,
  runGate,
  runSetupCommands,
  setField,
  startScoping,
  continueScoping,
  summarizeTask,
  worktreePath as computeWorktreePath,
  type FullEngineState,
  type ReviewerResult,
  type TesterResult,
} from "@crewbench/engine";
import type { RoleName, Project, TaskSpec } from "@crewbench/contract";
import { extractJiraKey, parseRunFlags } from "../flags.js";
import { resolveLineup, type ResolvedLineup } from "../lineup.js";
import { agentsDir, defaultsPath, schemaPath } from "../root.js";
import { ask, confirm } from "../prompt.js";

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

  // --- The fix loop, driven by the engine's pure reduce/decide ---
  let state: FullEngineState = reduce(initialState(), {
    type: "start",
    needsDesign,
    loop: lineup.loop,
  });
  await setField(taskDir, "phase", state.phase);
  await setField(taskDir, "round", state.round);

  for (;;) {
    const commands = decide(state);
    const command = commands[0];
    if (!command) break;

    if (command.type === "wait") {
      // Shouldn't happen in this single-threaded CLI driver (every phase
      // this loop reaches has a concrete next action), but bail out
      // clearly instead of spinning if it ever does.
      throw new Error(`engine returned "wait" in an unexpected phase: ${state.phase}`);
    }
    if (command.type === "dispatch_design") {
      console.log("Dispatching ui-ux...");
      const env = await dispatchRole(buildParams("ui-ux", lineup, taskDir, state.round, cwd, root, `Task: ${taskText}\n`));
      logRunResult("ui-ux", env);
      state = reduce(state, { type: "design.finished" });
    } else if (command.type === "dispatch_developer") {
      console.log(`Dispatching developer (round ${command.round})...`);
      const handoff = buildDeveloperHandoff(taskText, spec, command.fixList);
      const env = await dispatchRole(buildParams("developer", lineup, taskDir, command.round, cwd, root, handoff));
      logRunResult("developer", env);
      state = reduce(state, { type: "developer.finished" });
    } else if (command.type === "run_gate") {
      console.log(`Running gate (round ${command.round})...`);
      const { result } = await runGate(cwd, taskDir, command.round);
      console.log(result.ok ? "  gate: ok" : `  gate: FAILED at ${result.steps.at(-1)?.name}`);
      state = reduce(state, { type: "gate.finished", gate: result });
    } else if (command.type === "dispatch_verification") {
      console.log(`Dispatching tester + code-reviewer (round ${command.round})...`);
      const handoff = `Task: ${taskText}\n\nAcceptance criteria:\n${(spec?.acceptance_criteria ?? []).map((c) => `- ${c}`).join("\n")}`;
      const { tester, reviewer } = await dispatchVerification(
        buildParams("tester", lineup, taskDir, command.round, cwd, root, handoff),
        buildParams("code-reviewer", lineup, taskDir, command.round, cwd, root, handoff),
      );
      logRunResult("tester", tester);
      logRunResult("code-reviewer", reviewer);
      // Fall back to a safe, engine-shaped default whenever the dispatch
      // itself failed -- not just when `result` is null. dispatchRole()
      // now validates `result` against the role's schema (a real gap
      // fixed this milestone), but on a *mismatch* it still returns the
      // malformed object in `result`, not null, so checking `ok` here
      // (not just null-ness) is what actually keeps combinedFixList()'s
      // `tester.failures.map(...)` etc. from crashing on an undefined field.
      const testerResult = tester.ok ? (tester.result as TesterResult) : { verdict: "error" as const, failures: [] };
      const reviewerResult = reviewer.ok ? (reviewer.result as ReviewerResult) : { verdict: "changes_requested" as const, issues: [] };
      state = reduce(state, { type: "verification.finished", tester: testerResult, reviewer: reviewerResult });
    } else if (command.type === "request_commit_approval") {
      if (worktree) console.log(await diffStat(worktree, base));
      const yes = flags.yes ? false : await confirm("Commit this work?", true); // commit is NEVER auto-resolved by --yes
      if (!yes) {
        console.log("Not committing. Leaving the work as-is.");
        break;
      }
      const message = await ask(`Commit message [${title}]: `);
      const sha = await commitAll(worktree ?? cwd, message || title);
      console.log(`Committed ${sha.slice(0, 8)}.`);
      if (worktree && branch) {
        const choice = (await ask("Bring it back how? [merge/cherry-pick/leave/none]: ")).toLowerCase();
        if (choice === "merge" || choice === "cherry-pick") {
          await integrate(projectRoot, branch, choice, choice === "cherry-pick" ? sha : undefined);
          console.log(`${choice === "merge" ? "Merged" : "Cherry-picked"} onto the original branch.`);
        }
        if (await confirm("Remove the worktree now?", false)) {
          await removeWorktree(projectRoot, worktree, branch);
        }
      }
      state = reduce(state, { type: "commit.approved" });
    } else if (command.type === "finish") {
      const usage = {}; // per-role usage aggregation is milestone 6/daemon territory -- see phase-1-plan's note
      const summary = await summarizeTask(title, state, usage);
      console.log("\n" + summary);
      break;
    }

    await setField(taskDir, "phase", state.phase);
    await setField(taskDir, "round", state.round);
  }
}

function buildParams(
  role: RoleName,
  lineup: ResolvedLineup,
  taskDir: string,
  round: number,
  cwd: string,
  root: string,
  handoff: string,
) {
  const r = lineup.roles[role];
  return {
    role,
    cli: r.cli,
    model: r.model,
    effort: r.effort,
    permissions: r.permissions,
    taskDir,
    round,
    cwd,
    handoff,
    agentsDir: agentsDir(root),
    schemaPath: schemaPath(root, role),
  };
}

function buildDeveloperHandoff(taskText: string, spec: TaskSpec | null, fixList: unknown): string {
  const lines = [`Task: ${taskText}`];
  if (spec?.acceptance_criteria?.length) {
    lines.push("", "Acceptance criteria:", ...spec.acceptance_criteria.map((c) => `- ${c}`));
  }
  if (fixList) {
    lines.push("", "Fix list from the previous round:", JSON.stringify(fixList, null, 2));
  }
  return lines.join("\n");
}

function logRunResult(role: string, envelope: { ok: boolean; error: string | null }): void {
  console.log(`  ${role}: ${envelope.ok ? "done" : `FAILED — ${envelope.error}`}`);
}
