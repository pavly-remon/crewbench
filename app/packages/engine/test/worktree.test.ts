import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baseCommit,
  branchName,
  commitAll,
  copyWorkspaceFiles,
  createWorktree,
  currentBranch,
  deltaDiff,
  diffStat,
  dirName,
  integrate,
  isDirty,
  pruneWorktrees,
  removeWorktree,
  runSetupCommands,
  snapshotRef,
  worktreePath,
} from "../src/worktree.js";

const execFileAsync = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewbench-wt-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "hello\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("naming helpers", () => {
  it("uses the plain task id by default", () => {
    expect(dirName("t1")).toBe("t1");
    expect(branchName("t1")).toBe("crew/t1");
  });

  it("uses <jira-key>-<slug> when a Jira key is given", () => {
    expect(dirName("t1", "PROJ-123", "fix-login")).toBe("PROJ-123-fix-login");
    expect(branchName("t1", "PROJ-123", "fix-login")).toBe("crew/PROJ-123-fix-login");
  });

  it("nests the worktree under .crewbench/wt/", () => {
    expect(worktreePath("/repo", "t1")).toBe(join("/repo", ".crewbench", "wt", "t1"));
  });
});

describe("isDirty / baseCommit / currentBranch", () => {
  it("a clean tree is not dirty", async () => {
    const repo = await gitRepo();
    expect(await isDirty(repo)).toBe(false);
  });

  it("an uncommitted change is dirty", async () => {
    const repo = await gitRepo();
    await writeFile(join(repo, "a.txt"), "changed\n");
    expect(await isDirty(repo)).toBe(true);
  });

  it("reports HEAD and the current branch", async () => {
    const repo = await gitRepo();
    const head = await baseCommit(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const branch = await currentBranch(repo);
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });
});

describe("worktree lifecycle", () => {
  it("creates a worktree on a new branch at base_commit, runs setup, copies files, commits, integrates, and cleans up", async () => {
    const repo = await gitRepo();
    const base = await baseCommit(repo);
    const branch = branchName("t1");
    const path = worktreePath(repo, "t1");

    await createWorktree(repo, path, branch, base);
    expect(existsSync(path)).toBe(true);
    expect(await currentBranch(path)).toBe(branch);

    await runSetupCommands(path, ["node -e \"require('fs').writeFileSync('setup-ran.txt', 'ok')\""]);
    expect(existsSync(join(path, "setup-ran.txt"))).toBe(true);

    await writeFile(join(path, "b.txt"), "new file\n");
    const stat = await diffStat(path, base);
    expect(stat).toBe(""); // untracked, not yet added -- diff --stat only sees tracked changes

    const sha = await commitAll(path, "add b.txt");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const statAfter = await diffStat(path, base);
    expect(statAfter).toContain("b.txt");

    await integrate(repo, branch, "merge");
    const mainLog = await new Promise<string>((resolve, reject) => {
      execFile("git", ["log", "--oneline", "-1"], { cwd: repo }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    expect(mainLog).toContain("add b.txt");

    await removeWorktree(repo, path, branch);
    expect(existsSync(path)).toBe(false);
    await pruneWorktrees(repo); // should not throw even with nothing to prune
  });

  it("cherry-picks a specific commit instead of merging the whole branch", async () => {
    const repo = await gitRepo();
    const base = await baseCommit(repo);
    const branch = branchName("t2");
    const path = worktreePath(repo, "t2");
    await createWorktree(repo, path, branch, base);
    await writeFile(join(path, "c.txt"), "x\n");
    const sha = await commitAll(path, "add c.txt");

    await integrate(repo, branch, "cherry-pick", sha);
    expect(existsSync(join(repo, "c.txt"))).toBe(true);
  });

  it("'leave' and 'none' do not touch the main branch", async () => {
    const repo = await gitRepo();
    const base = await baseCommit(repo);
    const branch = branchName("t3");
    const path = worktreePath(repo, "t3");
    await createWorktree(repo, path, branch, base);
    await writeFile(join(path, "d.txt"), "x\n");
    await commitAll(path, "add d.txt");

    await integrate(repo, branch, "leave");
    expect(existsSync(join(repo, "d.txt"))).toBe(false);
    await integrate(repo, branch, "none");
    expect(existsSync(join(repo, "d.txt"))).toBe(false);
  });
});

describe("copyWorkspaceFiles", () => {
  it("copies only the patterns that actually exist in the main tree", async () => {
    const repo = await gitRepo();
    const base = await baseCommit(repo);
    const branch = branchName("t-copy");
    const path = worktreePath(repo, "t-copy");
    await createWorktree(repo, path, branch, base);

    await writeFile(join(repo, ".env"), "SECRET=1\n");
    const copied = await copyWorkspaceFiles(repo, path, [".env", ".env.local"]);
    expect(copied).toEqual([".env"]); // .env.local doesn't exist in the main tree
    expect(existsSync(join(path, ".env"))).toBe(true);
    expect(await readFile(join(path, ".env"), "utf-8")).toBe("SECRET=1\n");
  });
});

describe("snapshotRef + deltaDiff", () => {
  it("captures a round's changes without disturbing the working tree, and diffs against it later", async () => {
    const repo = await gitRepo();
    await writeFile(join(repo, "a.txt"), "round 1 change\n");
    const ref1 = await snapshotRef(repo);
    expect(ref1).not.toBeNull();
    // The working tree still has the uncommitted change -- snapshotRef must not disturb it.
    expect(await readFile(join(repo, "a.txt"), "utf-8")).toBe("round 1 change\n");
    expect(await isDirty(repo)).toBe(true);

    await writeFile(join(repo, "a.txt"), "round 2 change\n");
    const diff = await deltaDiff(repo, ref1 as string);
    expect(diff).toContain("round 2 change");
  });

  it("returns null when there is nothing to snapshot", async () => {
    const repo = await gitRepo();
    expect(await snapshotRef(repo)).toBeNull();
  });
});
