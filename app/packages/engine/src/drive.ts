import type { RoleName, TaskSpec } from "@crewbench/contract";
import type { Cli, Effort, Permissions } from "@crewbench/adapters";
import { commitAll, diffStat, integrate, removeWorktree, type IntegrateMode } from "./worktree.js";
import { requestApproval, resolveApproval, type ApprovalDecision } from "./approvals.js";
import type { ApprovalProvider } from "./approval-provider.js";
import { decide } from "./decide.js";
import { dispatchRole, dispatchVerification } from "./runner.js";
import { reduce, type FullEngineState } from "./reduce.js";
import { runGate } from "./gate.js";
import { setField } from "./task-store.js";
import { summarizeTask } from "./summary.js";
import type { ReviewerResult, TesterResult } from "./types.js";

/** The lineup/loop shape `driveTask()` needs -- a subset of
 * `packages/cli`'s `ResolvedLineup`, restated here rather than imported
 * (this module moved into `packages/engine` in Phase 3 milestone 1, and
 * `ResolvedLineup` is a CLI-flag-resolution concept that belongs in
 * `packages/cli`, not the engine -- see docs/app/phase-3-plan.md's open
 * question 1). Callers (both `packages/cli` and `packages/daemon`) hand
 * in their own resolved lineup, which is structurally compatible by
 * construction. **Deliberately excludes `workspace`**: `driveTask()`
 * never reads it (worktree setup happens entirely before this function
 * is ever called, in `run.ts`/the daemon's own task-creation path) --
 * confirmed by grepping this file before removing it, not assumed. This
 * also means a caller reattaching/resuming a task (Phase 3 milestone 1)
 * doesn't need to reconstruct `workspace.setup`/`.copy`, which aren't
 * persisted anywhere on disk after task creation. */
export interface DriveTaskLineup {
  roles: Record<RoleName, { cli: Cli; model: string; effort: Effort; permissions: Permissions }>;
  loop: { maxRounds: number; fixThreshold: "blocker" | "major" | "minor" };
}

export interface DriveTaskParams {
  state: FullEngineState;
  taskDir: string;
  cwd: string;
  lineup: DriveTaskLineup;
  agentsDir: string;
  schemaPathFor: (role: RoleName) => string;
  taskText: string;
  spec: TaskSpec | null;
  title: string;
  projectRoot: string;
  base: string;
  branch: string | null;
  worktree: string | null;
  /** Answers every approval point (Phase 3 milestone 1's
   * `ApprovalProvider`) -- a terminal-backed one for `crewbench run`/
   * `resume`, an HTTP-backed one for the daemon. */
  approvals: ApprovalProvider;
  /** `--yes`/non-interactive mode -- never bypasses the commit approval
   * itself (docs/app/CONTEXT.md's non-negotiable principle 3): under
   * `yes`, `driveTask()` declines commit without ever presenting the
   * approval at all, the same "the system never silently skips asking"
   * guarantee `approvals.ts`'s `NEVER_AUTO_RESOLVABLE` enforces for a
   * caller that tries to auto-resolve one directly. Only the
   * lower-stakes approval points reachable *after* a real commit
   * approval (integrate, cleanup_worktree) still go through `approvals`
   * even under `yes` -- in practice unreachable in `yes` mode today,
   * since execution never gets past a declined commit, but not special-
   * cased here so a future caller that resolves commit through some
   * other path doesn't silently skip them. */
  yes: boolean;
}

function buildParams(role: RoleName, p: DriveTaskParams, round: number, handoff: string) {
  const r = p.lineup.roles[role];
  return {
    role,
    cli: r.cli,
    model: r.model,
    effort: r.effort,
    permissions: r.permissions,
    taskDir: p.taskDir,
    round,
    cwd: p.cwd,
    handoff,
    agentsDir: p.agentsDir,
    schemaPath: p.schemaPathFor(role),
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

/** Requests one approval and resolves it through `resolveApproval()` --
 * always with `auto: false`, since every call site here represents a
 * real decision reaching a real provider (terminal or HTTP), never an
 * automated bypass (see `DriveTaskParams.yes`'s docstring for how `--yes`
 * actually skips the commit approval instead: by never calling this at
 * all for that one kind, not by resolving it automatically). */
async function askApproval(p: DriveTaskParams, kind: Parameters<typeof requestApproval>[0], payload: unknown): Promise<ApprovalDecision> {
  const request = requestApproval(kind, payload);
  const decision = await p.approvals.request(request);
  resolveApproval(request, decision, { auto: false });
  return decision;
}

/** Drives the engine's `reduce`/`decide` fix loop to completion (or to a
 * commit decline), dispatching real roles/gate/commit/integrate as each
 * `Command` calls for. Shared between `crewbench run` (a freshly
 * `start`ed state), `crewbench resume` (a state rehydrated from disk),
 * and the daemon's `TaskRunner` (Phase 3) -- all three end up with a
 * `FullEngineState`, an `ApprovalProvider`, and the same on-disk
 * task/worktree context, and from that point on the loop doesn't care how
 * the state was produced or who answers its approvals. */
export async function driveTask(p: DriveTaskParams): Promise<void> {
  let state = p.state;
  await setField(p.taskDir, "phase", state.phase);
  await setField(p.taskDir, "round", state.round);

  for (;;) {
    const commands = decide(state);
    const command = commands[0];
    if (!command) break;

    if (command.type === "wait") {
      throw new Error(`engine returned "wait" in an unexpected phase: ${state.phase}`);
    }
    if (command.type === "dispatch_design") {
      console.log("Dispatching ui-ux...");
      const env = await dispatchRole(buildParams("ui-ux", p, state.round, `Task: ${p.taskText}\n`));
      logRunResult("ui-ux", env);
      state = reduce(state, { type: "design.finished" });
    } else if (command.type === "dispatch_developer") {
      console.log(`Dispatching developer (round ${command.round})...`);
      const handoff = buildDeveloperHandoff(p.taskText, p.spec, command.fixList);
      const env = await dispatchRole(buildParams("developer", p, command.round, handoff));
      logRunResult("developer", env);
      state = reduce(state, { type: "developer.finished" });
    } else if (command.type === "run_gate") {
      console.log(`Running gate (round ${command.round})...`);
      const { result } = await runGate(p.cwd, p.taskDir, command.round);
      console.log(result.ok ? "  gate: ok" : `  gate: FAILED at ${result.steps.at(-1)?.name}`);
      state = reduce(state, { type: "gate.finished", gate: result });
    } else if (command.type === "dispatch_verification") {
      console.log(`Dispatching tester + code-reviewer (round ${command.round})...`);
      const handoff = `Task: ${p.taskText}\n\nAcceptance criteria:\n${(p.spec?.acceptance_criteria ?? []).map((c) => `- ${c}`).join("\n")}`;
      const { tester, reviewer } = await dispatchVerification(
        buildParams("tester", p, command.round, handoff),
        buildParams("code-reviewer", p, command.round, handoff),
      );
      logRunResult("tester", tester);
      logRunResult("code-reviewer", reviewer);
      // Fall back to a safe, engine-shaped default whenever the dispatch
      // itself failed, not just when `result` is null -- see
      // docs/app/phase-1-plan.md's milestone 5 note on why `ok` (not
      // result's nullness) is the right check.
      const testerResult = tester.ok ? (tester.result as TesterResult) : { verdict: "error" as const, failures: [] };
      const reviewerResult = reviewer.ok ? (reviewer.result as ReviewerResult) : { verdict: "changes_requested" as const, issues: [] };
      state = reduce(state, { type: "verification.finished", tester: testerResult, reviewer: reviewerResult });
    } else if (command.type === "request_commit_approval") {
      if (p.yes) {
        console.log("Not committing (--yes always declines commit approval).");
        break;
      }
      const diff = p.worktree ? await diffStat(p.worktree, p.base) : null;
      if (diff) console.log(diff);
      const commitDecision = await askApproval(p, "commit", { title: p.title, diffStat: diff });
      if (commitDecision.decision !== "yes") {
        console.log("Not committing. Leaving the work as-is.");
        break;
      }
      const message = ((commitDecision.data as { message?: string } | undefined)?.message || p.title).trim() || p.title;
      const sha = await commitAll(p.worktree ?? p.cwd, message);
      console.log(`Committed ${sha.slice(0, 8)}.`);
      if (p.worktree && p.branch) {
        const integrateDecision = await askApproval(p, "integrate", { branch: p.branch });
        const choice = (integrateDecision.data as { choice?: IntegrateMode } | undefined)?.choice ?? "none";
        if (choice === "merge" || choice === "cherry-pick") {
          await integrate(p.projectRoot, p.branch, choice, choice === "cherry-pick" ? sha : undefined);
          console.log(`${choice === "merge" ? "Merged" : "Cherry-picked"} onto the original branch.`);
        }
        const cleanupDecision = await askApproval(p, "cleanup_worktree", { worktree: p.worktree });
        if (cleanupDecision.decision === "yes") {
          await removeWorktree(p.projectRoot, p.worktree, p.branch);
        }
      }
      state = reduce(state, { type: "commit.approved" });
    } else if (command.type === "finish") {
      const usage = {}; // per-role usage aggregation lives in packages/daemon (Phase 2 milestone 4's aggregateUsage())
      const summary = await summarizeTask(p.title, state, usage);
      console.log("\n" + summary);
      break;
    }

    await setField(p.taskDir, "phase", state.phase);
    await setField(p.taskDir, "round", state.round);
  }
}
