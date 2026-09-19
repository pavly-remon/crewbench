import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function hashFile(cwd: string, path: string): Promise<string | null> {
  try {
    const data = await readFile(join(cwd, path));
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return null; // deleted, a symlink to nowhere, or unreadable
  }
}

/** Map path -> content hash (null if deleted) for every modified/added/
 * untracked-but-not-ignored path, from `git status --porcelain=v1 -z`.
 * Ported field-for-field from crewbench_dispatch.py's _dirty_snapshot(). */
async function dirtySnapshot(cwd: string): Promise<Record<string, string | null>> {
  let stdout: Buffer;
  try {
    stdout = await new Promise<Buffer>((resolve, reject) => {
      execFile("git", ["status", "--porcelain=v1", "-z"], { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
  } catch {
    return {};
  }
  const fields = stdout.toString("utf-8").split("\0");
  const dirty: Record<string, string | null> = {};
  let i = 0;
  while (i < fields.length) {
    const entry = fields[i] as string;
    i++;
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes("R") || code.includes("C")) i++; // rename/copy entries carry an extra "original path" field
    dirty[path] = code.includes("D") ? null : await hashFile(cwd, path);
  }
  return dirty;
}

export interface GitState {
  head: string;
  branch: string | null;
  remotes: string | null;
  stash: string;
  upstream: string | null;
  upstream_commit: string | null;
  dirty: Record<string, string | null>;
}

/** Snapshot HEAD, branch, remote refs, stash and working-tree dirt.
 * Returns null outside a git repo. Used both to report roles that change
 * git history and, via `dirty`, to catch a role silently reverting or
 * discarding its own (or an earlier round's) uncommitted work. Ported
 * field-for-field from crewbench_dispatch.py's git_state(). */
export async function gitState(cwd: string): Promise<GitState | null> {
  const head = await git(["rev-parse", "HEAD"], cwd);
  if (head === null) return null;
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  return {
    head,
    branch: await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    remotes: await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"], cwd),
    stash: (await git(["stash", "list", "--format=%H"], cwd)) ?? "",
    upstream,
    upstream_commit: upstream ? await git(["rev-parse", "@{u}"], cwd) : null,
    dirty: await dirtySnapshot(cwd),
  };
}

const TEST_PATH_PATTERN = /(^|[\\/])(tests?|__tests__|spec|e2e)([\\/]|$)|\.(test|spec)\.[^./\\]+$/i;

export function isTestPath(path: string, extraPattern?: RegExp): boolean {
  if (TEST_PATH_PATTERN.test(path)) return true;
  return Boolean(extraPattern && extraPattern.test(path));
}

export interface GitChanges {
  warnings: string[];
  notes: string[];
}

/** Describes what changed in the working tree and git state between two
 * gitState() snapshots. Report-only: never undoes anything. `role`
 * tailors a couple of checks (read-only reviewer, tester). Ported
 * field-for-field from crewbench_dispatch.py's git_changes(). */
export function gitChanges(role: Role, before: GitState | null, after: GitState | null, extraTestPattern?: RegExp): GitChanges {
  if (!before || !after) return { warnings: [], notes: [] };
  const warnings: string[] = [];
  const notes: string[] = [];

  if (before.branch !== after.branch) {
    warnings.push(`${role} switched branch ${before.branch} -> ${after.branch}`);
  }
  if (before.head !== after.head) {
    warnings.push(`${role} moved HEAD ${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)} (commit, reset or rebase)`);
  }
  if (before.stash !== after.stash) {
    warnings.push(`${role} changed the stash list (git stash)`);
  }

  const beforeDirty = before.dirty;
  const afterDirty = after.dirty;
  const reverted = Object.keys(beforeDirty)
    .filter((path) => !(path in afterDirty) || afterDirty[path] === null)
    .sort();
  if (reverted.length > 0) {
    warnings.push(`${role} reverted or deleted uncommitted changes in: ${reverted.join(", ")}`);
  }

  if (role === "code-reviewer" && !dirtyEqual(beforeDirty, afterDirty)) {
    warnings.push(`${role} is read-only but the working tree changed`);
  }

  if (role === "tester") {
    const touched = Object.keys(afterDirty).filter((p) => afterDirty[p] !== (p in beforeDirty ? beforeDirty[p] : null));
    const nonTest = touched.filter((p) => !isTestPath(p, extraTestPattern)).sort();
    if (nonTest.length > 0) {
      warnings.push(`tester changed non-test files: ${nonTest.join(", ")}`);
    }
  }

  if (before.remotes !== after.remotes) {
    const historyMoved = before.head !== after.head;
    const pushed = Boolean(
      before.upstream_commit &&
        after.upstream_commit &&
        before.upstream_commit !== after.upstream_commit &&
        after.upstream_commit === after.head,
    );
    if (pushed) {
      warnings.push(`${role} pushed to ${after.upstream ?? ""}`);
    } else if (!historyMoved) {
      notes.push("remote-tracking refs updated (likely git fetch)");
    } else {
      notes.push("remote-tracking refs changed alongside local history — not necessarily a push");
    }
  }

  return { warnings, notes };
}

function dirtyEqual(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}
