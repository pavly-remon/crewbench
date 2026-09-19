import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** `git rev-parse HEAD` -- ported from lib/dispatch.md §5 step 1. */
export async function baseCommit(cwd: string): Promise<string> {
  return git(["rev-parse", "HEAD"], cwd);
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/** Whether the main tree has uncommitted changes -- ported from lib/dispatch.md
 * §5 step 3 ("check whether the main tree is dirty"). Callers decide what
 * to do about it (ask the user; never stash or commit on their behalf). */
export async function isDirty(cwd: string): Promise<boolean> {
  const status = await git(["status", "--porcelain"], cwd);
  return status.length > 0;
}

export function dirName(taskId: string, jiraKey?: string | null, slug?: string): string {
  return jiraKey && slug ? `${jiraKey}-${slug}` : taskId;
}

export function branchName(taskId: string, jiraKey?: string | null, slug?: string): string {
  return `crew/${dirName(taskId, jiraKey, slug)}`;
}

export function worktreePath(mainRepoRoot: string, taskId: string, jiraKey?: string | null, slug?: string): string {
  return join(mainRepoRoot, ".crewbench", "wt", dirName(taskId, jiraKey, slug));
}

/** `git worktree add <path> -b <branch> <baseCommit>` -- ported from
 * lib/dispatch.md §5 step 4. Caller has already checked `isDirty()` and
 * gotten the user's decision on how to proceed; this function doesn't
 * re-check. */
export async function createWorktree(mainRepoRoot: string, path: string, branch: string, base: string): Promise<void> {
  await mkdir(join(mainRepoRoot, ".crewbench", "wt"), { recursive: true });
  await git(["worktree", "add", path, "-b", branch, base], mainRepoRoot);
}

/** Runs `workspace.setup`'s commands, in order, inside the worktree --
 * ported from lib/dispatch.md §5 step 5's "Environment setup". Each
 * command runs through the shell (these are user-configured commands
 * from team.json, not gate steps parsed from a single string, so no
 * argv-tokenizing pitfall applies here the way it does for gate.ts). */
export async function runSetupCommands(worktreePath: string, commands: readonly string[]): Promise<void> {
  for (const command of commands) {
    await execFileAsync(command, [], { cwd: worktreePath, shell: true, maxBuffer: 64 * 1024 * 1024 });
  }
}

/** Copies each of `patterns` from the main tree into the worktree, for
 * whichever ones actually exist there -- ported from lib/dispatch.md §5
 * step 5's "Offer to copy files matching workspace.copy". The caller has
 * already gotten the user's yes (these are often secrets, e.g. .env);
 * this function doesn't ask. Returns the subset that were actually
 * copied (some patterns may not exist in the main tree). */
export async function copyWorkspaceFiles(mainRepoRoot: string, worktreePath: string, patterns: readonly string[]): Promise<string[]> {
  const copied: string[] = [];
  for (const pattern of patterns) {
    const source = join(mainRepoRoot, pattern);
    if (existsSync(source)) {
      await copyFile(source, join(worktreePath, pattern));
      copied.push(pattern);
    }
  }
  return copied;
}

/** `git -C <worktree> diff --stat <base>` -- for the pre-commit summary
 * lib/dispatch.md §5's "Commit step" shows the user. */
export async function diffStat(worktreePath: string, base: string): Promise<string> {
  return git(["diff", "--stat", base], worktreePath);
}

/** `git -C <worktree> diff <fromRef> [toRef]` -- the "delta diff" per
 * round lib/dispatch.md §6 asks the reviewer for from round 2 on (what
 * changed since the previous round only). With no `toRef`, this compares
 * against the current *working tree* (plain `git diff <ref>`), not
 * `HEAD` -- the common case is diffing a previous round's snapshot
 * against this round's still-uncommitted work, which `git diff <ref>
 * HEAD` would not show at all (that only compares two commits). Pass an
 * explicit `toRef` to compare two fixed points instead. */
export async function deltaDiff(worktreePath: string, fromRef: string, toRef?: string): Promise<string> {
  const args = toRef ? ["diff", fromRef, toRef] : ["diff", fromRef];
  return git(args, worktreePath);
}

/** A round snapshot to diff against later -- `git stash create` captures
 * the working tree (including untracked-via-add) as a commit object
 * without actually stashing anything, so it doesn't disturb the tree.
 * Ported from lib/dispatch.md §6's "save a diff or a git stash create
 * snapshot's hash per round" note. Returns null if there's nothing to
 * snapshot (a clean tree). */
export async function snapshotRef(worktreePath: string): Promise<string | null> {
  await git(["add", "-A"], worktreePath); // stage first so stash create can see untracked/new files
  const ref = await git(["stash", "create"], worktreePath);
  await git(["reset"], worktreePath); // undo the staging, leave the tree exactly as it was
  return ref || null;
}

/** Commits everything currently in the worktree on its own branch --
 * ported from lib/dispatch.md §5's "Commit step": "only on an explicit
 * yes commit on the worktree's branch". This function performs the
 * commit; the explicit-yes gate is the caller's job (a later milestone's
 * approval flow) -- see docs/app/CONTEXT.md's non-negotiable principle 3:
 * commit/push are never auto-resolved, so nothing in this engine calls
 * this function without an external approval having already happened. */
export async function commitAll(worktreePath: string, message: string): Promise<string> {
  await git(["add", "-A"], worktreePath);
  await git(["commit", "-m", message], worktreePath);
  return git(["rev-parse", "HEAD"], worktreePath);
}

export type IntegrateMode = "merge" | "cherry-pick" | "leave" | "none";

/** Brings the worktree branch's commit back onto the original branch, per
 * lib/dispatch.md §5's "Ask how to bring the work back" — merge,
 * cherry-pick, leave the branch as-is, or do nothing. Runs against
 * `mainRepoRoot` (the original checkout), not the worktree. */
export async function integrate(mainRepoRoot: string, branch: string, mode: IntegrateMode, commit?: string): Promise<void> {
  if (mode === "merge") {
    await git(["merge", "--no-edit", branch], mainRepoRoot);
  } else if (mode === "cherry-pick") {
    if (!commit) throw new Error("cherry-pick requires the commit sha to pick");
    await git(["cherry-pick", commit], mainRepoRoot);
  }
  // "leave" and "none": no git operation -- the branch/commit already exists.
}

/** `git worktree remove` + delete the branch -- ported from lib/dispatch.md
 * §5's "Cleanup". Only call after the work is merged/cherry-picked or the
 * task is stopped, and only once the caller has the user's confirmation
 * (`/crewbench:status --cleanup`'s per-task confirmation). */
export async function removeWorktree(mainRepoRoot: string, path: string, branch: string): Promise<void> {
  await git(["worktree", "remove", path], mainRepoRoot);
  await rm(path, { recursive: true, force: true }); // in case `remove` left anything behind
  await git(["branch", "-D", branch], mainRepoRoot).catch(() => undefined); // best-effort: already merged branches may already be gone
}

/** `git worktree prune`, for worktree directories someone deleted by
 * hand outside git -- ported from lib/dispatch.md §5's Cleanup note. */
export async function pruneWorktrees(mainRepoRoot: string): Promise<void> {
  await git(["worktree", "prune"], mainRepoRoot);
}
