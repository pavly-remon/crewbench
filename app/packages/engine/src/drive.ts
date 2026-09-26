import type { RoleName, TaskSpec } from "@crewbench/contract";
import type { Cli, Effort, Permissions } from "@crewbench/adapters";
import { commitAll, diffStat, integrate, removeWorktree, type IntegrateMode } from "./worktree.js";
import { requestApproval, resolveApproval, type ApprovalDecision } from "./approvals.js";
import type { ApprovalProvider } from "./approval-provider.js";
import { decide } from "./decide.js";
import { dispatchRole, dispatchVerification } from "./runner.js";
import { DispatchCancelledError, type ConcurrencyLimiter } from "./concurrency.js";
import { reduce, type FullEngineState } from "./reduce.js";
import { runGate } from "./gate.js";
import { setField } from "./task-store.js";
import { appendEvent } from "./contract-fs.js";
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
  /** Phase 3 milestone 2's global scheduler -- omitted by
   * `crewbench run`/`resume` (one task, no reason to queue against
   * itself), one shared instance passed by the daemon's `TaskRunner`
   * across every active task, so `dispatchRole()`'s own per-CLI slot
   * gating (`runner.ts`) applies across the whole daemon process, not
   * just within one task's own dispatches. */
  limiter?: ConcurrencyLimiter;
  /** Phase 3 milestone 6's cancel control -- omitted by `crewbench run`/
   * `resume` (no HTTP caller to cancel from; a terminal `Ctrl-C` already
   * kills the whole process, no in-band signal needed), set by the
   * daemon's `TaskRunner` to one `AbortController`'s signal per active
   * task. Checked once per loop iteration, *between* commands, not
   * inside one -- this can't interrupt an `await dispatchRole(...)`
   * already in flight (finding 3 in this plan's own "Three real
   * findings" section: no live handle exists to interrupt with before a
   * dispatch's process exits). A caller that wants an in-flight
   * subprocess killed immediately, not just the loop stopped before its
   * *next* command, does that separately via `cancelRun()` against the
   * real pid already recorded in `status.json` (`runner.ts`, made real by
   * Phase 3 milestone 1's `onSpawn` fix) -- `routes/task-control.ts` does
   * both together. */
  cancelSignal?: AbortSignal;
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
    ...(p.limiter ? { limiter: p.limiter } : {}),
    ...(p.cancelSignal ? { cancelSignal: p.cancelSignal } : {}),
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

/** Persists the same `"stopped"`/`"cancelled by user"` outcome from two
 * real cancellation shapes: the loop's own top-of-iteration check
 * (`p.cancelSignal?.aborted` between commands, unchanged since Phase 3
 * milestone 6) and, as of this fix, a `DispatchCancelledError` thrown
 * *inside* a command -- a dispatch genuinely queued behind a full CLI
 * slot, or an approval genuinely pending, that `cancelTask()`'s abort
 * actually woke instead of leaving stuck forever (`concurrency.ts`'s own
 * `DispatchCancelledError` docstring has the real bug this closes).
 * Extracted so both call sites persist identically, not two
 * independently-maintained copies of the same three lines. */
async function persistCancelled(p: DriveTaskParams, state: FullEngineState): Promise<FullEngineState> {
  const next: FullEngineState = { ...state, phase: "stopped", stuckReason: "cancelled by user" };
  await setField(p.taskDir, "phase", next.phase);
  await setField(p.taskDir, "stuck_reason", next.stuckReason);
  return next;
}

/** Requests one approval and resolves it through `resolveApproval()` --
 * always with `auto: false`, since every call site here represents a
 * real decision reaching a real provider (terminal or HTTP), never an
 * automated bypass (see `DriveTaskParams.yes`'s docstring for how `--yes`
 * actually skips the commit approval instead: by never calling this at
 * all for that one kind, not by resolving it automatically).
 *
 * Phase 3 milestone 5: also appends `approval.requested`/`approval.
 * resolved` to `events.jsonl` around the real request/resolve, the
 * actual signal the daemon's inbox and desktop notifications react to
 * (see `docs/app/contract/events.md`'s entry for both -- neither event
 * type existed before this milestone; `packages/daemon/src/watcher.ts`
 * previously documented their absence explicitly, corrected alongside
 * this). This is the one real, disclosed edit to already-shipped Phase 3
 * milestone-1 code this milestone makes, per docs/app/CONTEXT.md's
 * working-agreement norm of flagging changes to shipped code rather than
 * touching it quietly. */
async function askApproval(p: DriveTaskParams, kind: Parameters<typeof requestApproval>[0], payload: unknown): Promise<ApprovalDecision> {
  const request = requestApproval(kind, payload);
  await appendEvent(p.taskDir, "approval.requested", { id: request.id, kind: request.kind, payload: request.payload });
  const decision = await p.approvals.request(request, p.cancelSignal);
  resolveApproval(request, decision, { auto: false });
  await appendEvent(p.taskDir, "approval.resolved", { id: request.id, kind: request.kind, decision: decision.decision });
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
  // Clears any `stuck_reason` left over from a *previous* run of this
  // task that ended cancelled -- resume()/retry-run() both call
  // `driveTask()` fresh from here, and a stale "cancelled by user" from
  // before must not keep showing on a task that's actively running again
  // (see the cancellation branch below for why this field exists at all).
  await setField(p.taskDir, "stuck_reason", null);

  const TERMINAL_PHASES = new Set(["done", "stopped", "failed"]);
  for (;;) {
    // Phase 3 milestone 6: a cancellation always wins over whatever
    // `decide()` would otherwise return next -- forcing `phase: "stopped"`
    // here, rather than adding a new `Command`/`decide()` case, reuses
    // the engine's *existing* "stopped" terminal path unchanged (the same
    // one gate-failure/stuck-detection already produce in `reduce.ts`):
    // the very next `decide(state)` call below returns
    // `{type:"finish", outcome:"stopped", ...}` on its own, so
    // `driveTask()`'s own `finish` branch summarizes and breaks exactly
    // as it already does for every other "stopped" cause. Skipped once
    // already terminal so a cancel racing the loop's own natural finish
    // doesn't overwrite a real `"done"`/`"failed"` outcome that beat it
    // there. **Persisted here explicitly, not left to the loop's own
    // trailing `setField()` calls**: a real, pre-existing gap found while
    // building this (not introduced by it) is that every `break` in this
    // loop -- including the `finish` branch just below, and the earlier
    // commit-decline branch -- exits *before* reaching those trailing
    // calls, so a state reached only via a `break` is never actually
    // written. That's harmless for a *successful* commit (reduce()
    // already persisted `phase: "done"` in the *previous* iteration,
    // before this one's `finish` no-ops over already-correct data) and
    // for gate-failure/stuck-detection (`reduce()` sets `"stopped"`
    // inside the `run_gate`/`dispatch_verification` branches themselves,
    // which don't `break`) -- but a cancellation reaches "stopped" for
    // the first time in a *fresh* iteration that goes straight to
    // `finish`, with no earlier iteration to have persisted it. Writing
    // it here, not fixing the loop's broader break/persist gap (the
    // commit-decline case genuinely never persists "stopped" either,
    // confirmed by reading it, but that's Phase 1 behavior this
    // milestone didn't touch and isn't the scoped fix here).
    //
    // Also persists `stuck_reason` itself (a new, additive `TaskState`
    // field, `@crewbench/contract`'s own docstring has the full story):
    // a second real, deeper gap found live while building this --
    // `FullEngineState.stuckReason` was, before this, purely an
    // in-memory value `rehydrateState()` re-derives by replaying
    // `runs/*.result.json` files through the same `reduce()` transitions
    // the live loop uses. That works for every *other* stopped reason
    // (gate failure, max rounds, a declined commit) because replay
    // independently arrives at the identical transition from the same
    // files. Cancellation has no file for replay to ever find -- it's a
    // pure runtime signal -- so without a real persisted field here,
    // `packages/daemon/src/task-detail.ts`'s `buildTaskDetail()` (which
    // reports `phase`/`stuck_reason` from `rehydrateState()`'s replay,
    // not this loop's own in-memory `state`) would show a cancelled task
    // as still mid-round forever, since replay has no way to know it was
    // cancelled. `task-detail.ts` reads this field back to override
    // exactly that case -- see its own docstring.
    if (p.cancelSignal?.aborted && !TERMINAL_PHASES.has(state.phase)) {
      state = await persistCancelled(p, state);
    }
    const commands = decide(state);
    const command = commands[0];
    if (!command) break;

    if (command.type === "wait") {
      throw new Error(`engine returned "wait" in an unexpected phase: ${state.phase}`);
    }
    // Real, disclosed gap Copilot review caught (`DispatchCancelledError`'s
    // own docstring in concurrency.ts has the full story): a dispatch
    // genuinely queued behind a full CLI slot, or an approval genuinely
    // pending, used to have no way to observe `p.cancelSignal` firing --
    // `cancelTask()`'s abort only ever mattered *between* commands, at
    // the top-of-loop check above, never *inside* one already in flight
    // at the `await` level. `ConcurrencyLimiter.acquire()`/
    // `HttpApprovalProvider.request()` now both reject with this one
    // error type the instant the signal fires; caught here, once, around
    // every command that could possibly throw it, and persisted through
    // the exact same `persistCancelled()` the between-commands case
    // already uses -- not a second, parallel cancellation code path. */
    try {
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
          // Real, disclosed gap caught by review: `reduce.ts` already
          // has a real, unit-tested `"commit.declined"` transition
          // (`phase: "stopped", stuckReason: "user declined the
          // commit"`), but this `break` used to exit the loop before
          // ever calling it *or* reaching the trailing `setField()`
          // calls at the loop's own bottom -- `state.json`'s on-disk
          // phase stayed stuck at whatever `decide()` last saw as
          // "awaiting_commit" (the phase that produced this very
          // command in the first place). A daemon restart later reads
          // that stale, non-terminal phase and wrongly re-enters the
          // approval flow for a task that was actually declined and
          // done. Persisted explicitly here, not left to the trailing
          // calls, for the identical reason `persistCancelled()`'s own
          // docstring already explains for the cancellation case: this
          // `break` exits before ever reaching them.
          state = reduce(state, { type: "commit.declined" });
          await setField(p.taskDir, "phase", state.phase);
          await setField(p.taskDir, "stuck_reason", state.stuckReason);
          break;
        }
        const diff = p.worktree ? await diffStat(p.worktree, p.base) : null;
        if (diff) console.log(diff);
        const commitDecision = await askApproval(p, "commit", { title: p.title, diffStat: diff });
        if (commitDecision.decision !== "yes") {
          console.log("Not committing. Leaving the work as-is.");
          // Same real, disclosed gap as the `--yes` branch just above --
          // see its own comment for the full story.
          state = reduce(state, { type: "commit.declined" });
          await setField(p.taskDir, "phase", state.phase);
          await setField(p.taskDir, "stuck_reason", state.stuckReason);
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
    } catch (err) {
      if (!(err instanceof DispatchCancelledError)) throw err;
      state = await persistCancelled(p, state);
      break;
    }

    await setField(p.taskDir, "phase", state.phase);
    await setField(p.taskDir, "round", state.round);
  }
}
